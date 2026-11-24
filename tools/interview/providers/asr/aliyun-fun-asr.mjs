// 阿里云百炼 Fun-ASR-Realtime WebSocket adapter（spec §3.2）。
// 协议：run-task → task-started → binary PCM（Header+payload）→ finish-task → task-finished；
// result-generated 映射 partial/final（sentence_end）；heartbeat 忽略；task-failed → error。
// 超时：任务启动 10s；finish flush 5s；重连默认 2 次（新 streamId）。Key 只在本地 server 进程。
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

// PCM 帧前需 4 字节 Header（spec §3.2：带 4 字节头）；此处生成负载数据帧头
// 格式参考 Fun-ASR WS 协议：header(4B) + payload；header 第 2 字节低 4 位 = 序列类型（0=全量）
function pcmFrameHeader() {
  return Buffer.from([0x10, 0x10, 0x00, 0x00]);
}

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

  id() { return 'aliyun-fun-asr'; }

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
        const runTask = {
          header: { message_id: randomUUID(), task_id: this.taskId, action: 'run-task', streaming: 'in' },
          message_type: 'run-task',
          task: 'asr',
          payload: {
            model: this.model,
            task_group: 'asr',
            task: 'asr',
            function: 'recognition',
            format: 'pcm',
            sample_rate: 16000,
            language_hints: ['zh', 'en'],
            ...(this.vocabularyId ? { vocabulary_id: this.vocabularyId } : {}),
          },
        };
        ws.send(JSON.stringify(runTask));
        resolve();
      });
      ws.on('message', (raw, isBinary) => this.onMessage(raw, isBinary));
      ws.on('error', (e) => {
        clearTimeout(failTimer);
        this.emit?.({ provider: this.id(), streamId: this.streamId, segmentId: '', revision: 0, channel: 'mic', type: 'error', code: 'WS_ERROR', message: e.message });
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
    if (msg.message_type === 'task-started') {
      this.taskId = msg.task_id;
      this.started = true;
      // 放行缓冲中的音频
      for (const frame of this.pendingPcm) this.sendPcm(frame);
      this.pendingPcm = [];
      return;
    }
    if (msg.message_type === 'heartbeat') return; // 忽略
    if (msg.message_type === 'task-failed') {
      this.emit({
        provider: this.id(), streamId: this.streamId, segmentId: '', revision: 0, channel: 'mic',
        type: 'error', code: String(msg.code || 'TASK_FAILED'), message: msg.message || 'task-failed',
      });
      return;
    }
    if (msg.message_type === 'task-finished') {
      this.started = false;
      return;
    }
    if (msg.message_type === 'result-generated') {
      const out = msg.payload?.output || {};
      const segmentId = String(out.sentence_id ?? '');
      const isFinal = out.sentence_end === true;
      const rev = (this.revisions.get(segmentId) || 0) + (isFinal ? 1 : 1);
      this.revisions.set(segmentId, rev);
      this.emit({
        provider: this.id(),
        streamId: this.streamId,
        segmentId,
        revision: rev,
        channel: 'mic',
        type: isFinal ? 'final' : 'partial',
        startMs: out.begin_time ?? 0,
        endMs: out.end_time ?? 0,
        text: out.text || '',
      });
      void rev;
      this.revisions.set(segmentId, this.revisions.get(segmentId));
    }
  }

  sendPcm(frame) {
    // 协议：binary 帧 = 4B header + PCM payload
    const header = pcmFrameHeader();
    const buf = Buffer.concat([header, frame]);
    this.ws.send(buf, { binary: true });
    void buf;
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
      this.started = false;
      this.connect().catch(() => {
        this.emit?.({ provider: this.id(), streamId: this.streamId, segmentId: '', revision: 0, channel: 'mic', type: 'error', code: 'RECONNECT_FAILED', message: '重连失败' });
      });
    } else {
      this.emit?.({ provider: this.id(), streamId: this.streamId, segmentId: '', revision: 0, channel: 'mic', type: 'error', code: 'DISCONNECTED', message: `连接断开且重连次数用尽（${this.maxReconnects}）` });
    }
  }

  async push(pcm) {
    if (this.closed) throw new Error('provider 已关闭');
    if (!this.started) {
      this.pendingPcm.push(pcm);
      if (this.pendingPcm.length > 20) { // 20×100ms = 2s 缓冲上限
        this.pendingPcm.shift();
        this.emit?.({ provider: this.id(), streamId: this.streamId, segmentId: '', revision: 0, channel: 'mic', type: 'gap', code: 'BUFFER_OVERFLOW', message: 'task-started 前缓冲溢出，丢弃最旧帧' });
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
          if (msg.message_type === 'task-finished') {
            clearTimeout(timer);
            this.removeListener('message', onFinished);
            resolve();
          }
        } catch { /* 非 JSON 忽略，继续等 */ }
      });
      this.ws.send(JSON.stringify({
        header: { message_id: randomUUID(), task_id: this.taskId, action: 'finish-task', streaming: 'in' },
        message_type: 'finish-task',
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
