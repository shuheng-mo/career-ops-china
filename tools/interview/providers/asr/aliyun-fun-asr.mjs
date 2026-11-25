// 阿里云百炼 Fun-ASR-Realtime WebSocket adapter（spec §3.2，协议对齐官方 WebSocket 接入指南）。
// 协议：run-task → task-started → binary 裸 PCM → finish-task → task-finished；
// 事件在 header.event（task-started/result-generated/task-finished/task-failed）；
// result-generated 的 payload.output.sentence：end_time 为 null = partial，非 null = final。
// 超时：任务启动 10s；finish flush 5s；重连默认 2 次（新 streamId）。Key 只在本地 server 进程。
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export class AliyunFunAsrProvider {
  constructor({ endpoint, apiKey, model = 'fun-asr-realtime', vocabularyId = '', maxReconnects = 2, startTimeoutMs = 10000, flushTimeoutMs = 5000 } = {}) {
    if (!endpoint || !apiKey) throw new Error('Fun-ASR 需要 endpoint 与 apiKey（本地进程持有，不进浏览器/日志）');
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.model = model;
    this.vocabularyId = vocabularyId;
    this.maxReconnects = maxReconnects;
    this.startTimeoutMs = startTimeoutMs;
    this.flushTimeoutMs = flushTimeoutMs;
    this.sessionId = null;
    this.streamId = null;
    this.emit = null;
    this.ws = null;
    this.closed = false;
    this.reconnects = 0;
    this.pendingPcm = []; // task-started 前缓冲
    this.started = false;
    this.revisions = new Map(); // segmentId → last revision
  }

  id = 'aliyun-fun-asr';

  capabilities() {
    return { streaming: true, hotwords: true, diarization: false, timestamps: true };
  }

  async probe() {
    // 不打真实 API（用户 Key 验收阶段做 smoke）；仅校验配置存在
    if (!this.endpoint || !this.apiKey) return { ok: false, reason: '缺少 endpoint 或 apiKey（env 配置）' };
    return { ok: true, reason: '配置存在（网络连通性由用户验收 smoke 验证）' };
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.endpoint, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        handshakeTimeout: this.startTimeoutMs,
      });
      const failTimer = setTimeout(() => {
        req.destroy(new Error(`任务启动超时（${this.startTimeoutMs}ms）`));
      }, this.startTimeoutMs);
      const req = { destroy: () => { ws.terminate(); clearTimeout(failTimer); reject(new Error(`任务启动超时（${this.startTimeoutMs}ms）`)); } };
      ws.on('open', () => {
        clearTimeout(failTimer);
        this.ws = ws;
        // task-started 单独计时（open ≠ started）：超时按启动失败处理
        this.startedTimer = setTimeout(() => {
          this.emit?.({ provider: this.id, streamId: this.streamId, segmentId: '', revision: 0, channel: 'mic', type: 'error', code: 'START_TIMEOUT', message: `task-started 超时（${this.startTimeoutMs}ms）` });
          this.handleDisconnect();
        }, this.startTimeoutMs);
        const runTask = {
          header: { task_id: this.taskId, action: 'run-task', streaming: 'duplex' },
          payload: {
            task_group: 'audio',
            task: 'asr',
            function: 'recognition',
            model: this.model,
            parameters: {
              format: 'pcm',
              sample_rate: 16000,
              language_hints: ['zh', 'en'],
              ...(this.vocabularyId ? { vocabulary_id: this.vocabularyId } : {}),
            },
            input: {},
          },
        };
        ws.send(JSON.stringify(runTask));
        resolve();
      });
      ws.on('message', (raw, isBinary) => this.onMessage(raw, isBinary));
      ws.on('error', (e) => {
        clearTimeout(failTimer);
        this.emit?.({ provider: this.id, streamId: this.streamId, segmentId: '', revision: 0, channel: 'mic', type: 'error', code: 'WS_ERROR', message: e.message });
        reject(e);
      });
      ws.on('close', () => {
        clearTimeout(failTimer);
        if (this.closed) return;
        this.handleDisconnect();
      });
    });
  }

  onMessage(raw, isBinary) {
    if (isBinary) return; // 服务端不下发音频
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const event = msg.header?.event;
    if (event === 'task-started') {
      clearTimeout(this.startedTimer);
      this.taskId = msg.header.task_id || this.taskId; // 每轮 run-task 重新生成，重连不复用旧 taskId
      this.started = true;
      // 放行缓冲中的音频
      for (const frame of this.pendingPcm) this.sendPcm(frame);
      this.pendingPcm = [];
      return;
    }
    if (event === 'heartbeat') return; // 忽略
    if (event === 'task-failed') {
      this.emit({
        provider: this.id, streamId: this.streamId, segmentId: '', revision: 0, channel: 'mic',
        type: 'error', code: String(msg.header.error_code || 'TASK_FAILED'), message: msg.header.error_message || 'task-failed',
      });
      return;
    }
    if (event === 'task-finished') {
      this.started = false;
      return;
    }
    if (event === 'result-generated') {
      const sentence = msg.payload?.output?.sentence || {};
      // 官方协议无 sentence_id：同一句子的 partial 序列以 begin_time 为锚递增 revision
      const segmentId = `t${sentence.begin_time ?? 0}`;
      const isFinal = sentence.end_time !== null && sentence.end_time !== undefined;
      const rev = (this.revisions.get(segmentId) || 0) + 1;
      this.revisions.set(segmentId, rev);
      this.emit({
        provider: this.id,
        streamId: this.streamId,
        segmentId,
        revision: rev,
        channel: 'mic',
        type: isFinal ? 'final' : 'partial',
        startMs: sentence.begin_time ?? 0,
        endMs: sentence.end_time ?? 0,
        text: sentence.text || '',
      });
    }
  }

  sendPcm(frame) {
    // 发送缓冲上限 2 秒音频（16k s16le ≈ 64KB/s → 128KB）：超限丢帧 + gap（spec §9.3）
    if ((this.ws.bufferedAmount || 0) > 128000) {
      this.emit?.({ provider: this.id, streamId: this.streamId, segmentId: '', revision: 0, channel: 'mic', type: 'gap', code: 'SEND_BUFFER_FULL', message: '发送缓冲超限，丢帧' });
      return;
    }
    // 官方 WebSocket 协议：binary 帧直发裸 PCM（无帧头）
    this.ws.send(frame, { binary: true });
  }

  async start({ sessionId, channel, sampleRate, signal }, emitFn) {
    if (this.closed) throw new Error('provider 已关闭');
    this.sessionId = sessionId;
    this.emit = emitFn;
    this.streamId = `fun-${Date.now()}-${randomUUID().slice(0, 6)}`;
    this.taskId = randomUUID();
    void channel; void sampleRate; void signal;
    await this.connect();
    // task-started 前不发音频（缓冲逻辑在 push）
    return;
  }

  handleDisconnect() {
    if (this.closed) return;
    if (this.reconnects < this.maxReconnects) {
      this.reconnects += 1;
      this.streamId = `fun-${Date.now()}-${randomUUID().slice(0, 6)}`; // 重连 = 新 streamId
      this.taskId = randomUUID(); // 重连 = 新 taskId（不复用旧轮服务端 task_id）
      this.started = false;
      this.connect().catch(() => {
        this.emit?.({ provider: this.id, streamId: this.streamId, segmentId: '', revision: 0, channel: 'mic', type: 'error', code: 'RECONNECT_FAILED', message: '重连失败' });
      });
    } else {
      this.emit?.({ provider: this.id, streamId: this.streamId, segmentId: '', revision: 0, channel: 'mic', type: 'error', code: 'DISCONNECTED', message: `连接断开且重连次数用尽（${this.maxReconnects}）` });
    }
  }

  async push(pcm) {
    if (this.closed) throw new Error('provider 已关闭');
    if (!this.started) {
      this.pendingPcm.push(pcm);
      if (this.pendingPcm.length > 20) { // 20×100ms = 2s 缓冲上限
        this.pendingPcm.shift();
        this.emit?.({ provider: this.id, streamId: this.streamId, segmentId: '', revision: 0, channel: 'mic', type: 'gap', code: 'BUFFER_OVERFLOW', message: 'task-started 前缓冲溢出，丢弃最旧帧' });
      }
      return;
    }
    this.sendPcm(pcm);
  }

  async finish() {
    if (this.closed || !this.ws) return;
    // flush：发送 finish-task，等待 task-finished（5s 超时强制返回）
    await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), this.flushTimeoutMs);
      this.ws.once('message', function onFinished(raw) {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.header?.event === 'task-finished') {
            clearTimeout(timer);
            this.removeListener('message', onFinished);
            resolve();
          }
        } catch { /* 非 JSON 忽略，继续等 */ }
      });
      this.ws.send(JSON.stringify({
        header: { task_id: this.taskId, action: 'finish-task', streaming: 'duplex' },
        payload: { input: {} },
      }));
    });
  }

  async close() {
    if (this.closed) return; // 幂等
    this.closed = true;
    try { this.ws?.close(); } catch { /* 忽略 */ }
    this.ws = null;
    this.emit = null;
  }
}
