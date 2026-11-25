import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { AliyunFunAsrProvider } from '../providers/asr/aliyun-fun-asr.mjs';

// 本地 ws stub：按百炼 Fun-ASR-Realtime 官方 WebSocket 协议应答（header.event 分发；
// payload.parameters 嵌套；裸 PCM binary 帧），行为可编程
function startProtocolStub({ failTask, emit: emitScript } = {}) {
  const log = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  let taskId = 'task-stub-1';
  wss.on('connection', (ws) => {
    ws.on('message', (raw, isBinary) => {
      if (isBinary) { log.push({ binary: true, bytes: raw.length }); return; }
      const msg = JSON.parse(raw.toString());
      log.push(msg);
      if (msg.header?.action === 'run-task') {
        if (failTask) {
          ws.send(JSON.stringify({ header: { event: 'task-failed', task_id: taskId, error_code: 45000001, error_message: 'stub 失败' } }));
          return;
        }
        ws.send(JSON.stringify({ header: { event: 'task-started', task_id: taskId } }));
        ws._taskId = taskId;
      } else if (msg.header?.action === 'finish-task') {
        ws.send(JSON.stringify({ header: { event: 'task-finished', task_id: ws._taskId } }));
      }
      void WebSocket;
    });
    if (emitScript) {
      emitScript(ws, taskId);
    }
  });
  const close = () => {
    wss.closeAllConnections?.();
    wss.close();
  };
  return new Promise((resolve) => {
    wss.on('listening', () => resolve({
      close, log,
      url: `ws://127.0.0.1:${wss.address().port}`,
      sendToClient: (payload) => { for (const ws of wss.clients) ws.send(payload); },
    }));
  });
}

function pcmFrame(ms = 100) {
  // 16k mono s16le：100ms = 1600 samples = 3200 bytes
  return Buffer.alloc(1600 * 2 * (ms / 100), 0);
}

test('[P4.2] run-task 报文符合官方协议；task-started 前不发音频；PCM 裸发无帧头', async () => {
  const stub = await startProtocolStub();
  const provider = new AliyunFunAsrProvider({ endpoint: stub.url, apiKey: 'sk-test', model: 'fun-asr-realtime' });
  const events = [];
  await provider.start({ sessionId: 's1', channel: 'mic', sampleRate: 16000 }, (e) => events.push(e));
  await provider.push(pcmFrame());
  await new Promise((r) => setTimeout(r, 120));
  const runTask = stub.log.find((m) => m.header?.action === 'run-task');
  assert.ok(runTask, '应发送 run-task');
  assert.equal(runTask.header.streaming, 'duplex');
  assert.equal(runTask.payload.task_group, 'audio');
  assert.equal(runTask.payload.task, 'asr');
  assert.equal(runTask.payload.function, 'recognition');
  assert.equal(runTask.payload.model, 'fun-asr-realtime');
  assert.equal(runTask.payload.parameters.sample_rate, 16000);
  assert.equal(runTask.payload.parameters.format, 'pcm');
  assert.ok(runTask.payload.input, 'payload.input 必须存在（官方结构）');
  // 裸 PCM：binary 帧长度 = 原始 PCM 字节数（3200），不带任何帧头
  const bin = stub.log.find((m) => m.binary);
  assert.ok(bin, '应有 binary 音频帧');
  assert.equal(bin.bytes, 3200, `PCM 应裸发（期望 3200 字节，实际 ${bin.bytes}）`);
  // 音频帧必须在 run-task 之后（stub 收到的消息序）
  const runIdx = stub.log.findIndex((m) => m.header?.action === 'run-task');
  const pcmIdx = stub.log.findIndex((m) => m.binary);
  assert.ok(pcmIdx > runIdx, `PCM 应在 task-started 后（run=${runIdx}, pcm=${pcmIdx}）`);
  await provider.close();
  stub.close();
});

test('[P4.2] result-generated 映射：end_time null → partial，非 null → final', async () => {
  const stub = await startProtocolStub({
    emit: (ws, taskId) => {
      setTimeout(() => {
        ws.send(JSON.stringify({ header: { event: 'task-started', task_id: taskId } }));
        ws.send(JSON.stringify({
          header: { event: 'result-generated', task_id: taskId },
          payload: { output: { sentence: { begin_time: 0, end_time: null, text: '介绍' } } },
        }));
        ws.send(JSON.stringify({
          header: { event: 'result-generated', task_id: taskId },
          payload: { output: { sentence: { begin_time: 0, end_time: 1800, text: '介绍一下你的项目' } } },
        }));
        ws.send(JSON.stringify({ header: { event: 'heartbeat', task_id: taskId } }));
      }, 30);
    },
  });
  const provider = new AliyunFunAsrProvider({ endpoint: stub.url, apiKey: 'sk-test', model: 'fun-asr-realtime' });
  const events = [];
  await provider.start({ sessionId: 's1', channel: 'mic', sampleRate: 16000 }, (e) => events.push(e));
  await provider.push(pcmFrame());
  await new Promise((r) => setTimeout(r, 250));
  const partials = events.filter((e) => e.type === 'partial');
  const finals = events.filter((e) => e.type === 'final');
  assert.equal(partials.length, 1);
  assert.equal(partials[0].text, '介绍');
  assert.equal(partials[0].segmentId, 't0');
  assert.equal(partials[0].revision, 1);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, '介绍一下你的项目');
  assert.equal(finals[0].endMs, 1800);
  assert.ok(!events.some((e) => e.type === 'heartbeat'), 'heartbeat 不产生事件');
  await provider.close();
  stub.close();
});

test('[P4.2] task-failed → error 事件（header.error_code/error_message）', async () => {
  const stub = await startProtocolStub({ failTask: true });
  const provider = new AliyunFunAsrProvider({ endpoint: stub.url, apiKey: 'sk-test', model: 'fun-asr-realtime' });
  const events = [];
  await provider.start({ sessionId: 's1', channel: 'mic', sampleRate: 16000 }, (e) => events.push(e));
  await new Promise((r) => setTimeout(r, 150));
  const err = events.find((e) => e.type === 'error');
  assert.ok(err, '应有 error 事件');
  assert.equal(err.code, '45000001');
  assert.match(err.message, /stub 失败/);
  await provider.close();
  stub.close();
});

test('[P4.2] finish-task 报文符合官方协议；task-finished 后 flush 返回', async () => {
  const stub = await startProtocolStub();
  const provider = new AliyunFunAsrProvider({ endpoint: stub.url, apiKey: 'sk-test', model: 'fun-asr-realtime' });
  const events = [];
  await provider.start({ sessionId: 's1', channel: 'mic', sampleRate: 16000 }, (e) => events.push(e));
  await new Promise((r) => setTimeout(r, 120));
  await provider.finish();
  const finishTask = stub.log.find((m) => m.header?.action === 'finish-task');
  assert.ok(finishTask, 'finish 应发送 finish-task');
  assert.equal(finishTask.header.streaming, 'duplex');
  assert.ok(finishTask.payload?.input, 'payload.input 必须存在（官方结构）');
  await provider.close();
  stub.close();
});

test('[P4.R] close 后在途 result-generated → 忽略，不崩进程（emit 已置 null）', async () => {
  const stub = await startProtocolStub({
    emit: (ws, taskId) => {
      setTimeout(() => {
        ws.send(JSON.stringify({ header: { event: 'task-started', task_id: taskId } }));
      }, 20);
    },
  });
  const provider = new AliyunFunAsrProvider({ endpoint: stub.url, apiKey: 'sk-test', model: 'fun-asr-realtime' });
  const events = [];
  await provider.start({ sessionId: 's1', channel: 'mic', sampleRate: 16000 }, (e) => events.push(e));
  await new Promise((r) => setTimeout(r, 80));
  await provider.close(); // this.emit → null；真实事故：stop 后在途识别结果到达即崩
  stub.sendToClient(JSON.stringify({
    header: { event: 'result-generated', task_id: 'x' },
    payload: { output: { sentence: { begin_time: 0, end_time: 500, text: '在途' } } },
  }));
  stub.sendToClient(JSON.stringify({
    header: { event: 'task-failed', task_id: 'x', error_code: 1, error_message: 'late' },
  }));
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(!events.some((e) => e.text === '在途'), 'close 后事件应被忽略');
  stub.close();
});

test('[P4.R] 服务端畸形报文（JSON null）→ 监听器自兜底，不外泄异常', async () => {
  const stub = await startProtocolStub();
  const provider = new AliyunFunAsrProvider({ endpoint: stub.url, apiKey: 'sk-test', model: 'fun-asr-realtime' });
  const events = [];
  await provider.start({ sessionId: 's1', channel: 'mic', sampleRate: 16000 }, (e) => events.push(e));
  await new Promise((r) => setTimeout(r, 80));
  stub.sendToClient('null'); // JSON.parse('null') → null，读 null.header 若无兜底直接杀进程
  stub.sendToClient(JSON.stringify({ header: { event: 'result-generated' }, payload: { output: { sentence: { begin_time: 0, end_time: 500, text: 'ok' } } } }));
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(events.some((e) => e.type === 'final' && e.text === 'ok'), '兜底后正常报文仍可处理');
  await provider.close();
  stub.close();
});

// ws 库的句柄在 keep-alive/半关连接下会挂住测试进程——全部测试完成后强制收尾
import { after as _after } from 'node:test';
_after(() => { setTimeout(() => process.exit(0), 300); });
