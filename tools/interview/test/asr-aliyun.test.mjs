import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { AliyunFunAsrProvider } from '../providers/asr/aliyun-fun-asr.mjs';

// 本地 ws stub：按 Fun-ASR 协议应答，行为可编程
function startProtocolStub({ failTask, emit: emitScript } = {}) {
  const log = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const sent = [];
  let taskId = 'task-stub-1';
  wss.on('connection', (ws) => {
    ws.on('message', (raw, isBinary) => {
      if (isBinary) { log.push({ header: { type: 'pcm' } }); return; }
      const msg = JSON.parse(raw.toString());
      log.push(msg);
      if (msg.message_type === 'run-task') {
        if (failTask) {
          ws.send(JSON.stringify({ message_type: 'task-failed', task_id: taskId, code: 45000001, message: 'stub 失败' }));
          return;
        }
        ws.send(JSON.stringify({ message_type: 'task-started', task_id: taskId }));
        ws._taskId = taskId;
      } else if (msg.message_type === 'finish-task') {
        ws.send(JSON.stringify({ message_type: 'task-finished', task_id: ws._taskId }));
      } else if (msg.message_type === 'heartbeat') {
        // heartbeat 不应答（协议：服务端可发；stub 收到即可）——客户端不应把 heartbeat 当事件
      }
      void sent;
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
  return Buffer.alloc(1600 * 2, 0);
}

test('[P4.2] 协议：run-task → task-started 前不发音频；PCM 帧带 task_id 头', async () => {
  const stub = await startProtocolStub();
  const provider = new AliyunFunAsrProvider({ endpoint: stub.url, apiKey: 'sk-test', model: 'fun-asr-realtime' });
  const events = [];
  await provider.start({ sessionId: 's1', channel: 'mic', sampleRate: 16000 }, (e) => events.push(e));
  await provider.push(pcmFrame());
  // 给 stub 一点时间
  await new Promise((r) => setTimeout(r, 120));
  const runTask = stub.log.find((m) => m.message_type === 'run-task');
  assert.ok(runTask, '应发送 run-task');
  assert.equal(runTask.task, 'asr');
  assert.equal(runTask.payload.model, 'fun-asr-realtime');
  assert.equal(runTask.payload.sample_rate, 16000);
  assert.equal(runTask.payload.format, 'pcm');
  assert.ok(stub.log.filter((m) => m.message_type === 'run-task').every(() => true));
  // 音频帧必须在 task-started 之后才发（stub 收到的消息序）
  const runIdx = stub.log.findIndex((m) => m.message_type === 'run-task');
  const pcmIdx = stub.log.findIndex((m) => m.header?.type === 'pcm');
  assert.ok(pcmIdx > runIdx, `PCM 应在 task-started 后（run=${runIdx}, pcm=${pcmIdx}）`);
  await provider.close();
  stub.close();
});

test('[P4.2] result-generated 映射：partial / sentence_end → final', async () => {
  const stub = await startProtocolStub({
    emit: (ws, taskId) => {
      // task-started 后由测试触发文本
      setTimeout(() => {
        ws.send(JSON.stringify({ message_type: 'task-started', task_id: taskId }));
        ws.send(JSON.stringify({ header: { type: 'pcm' } })); // 占位，触发 pending 帧放行
        ws.send(JSON.stringify({
          message_type: 'result-generated', task_id: taskId,
          payload: { output: { sentence_id: 1, begin_time: 0, end_time: 900, text: '介绍' , sentence_end: false } },
        }));
        ws.send(JSON.stringify({
          message_type: 'result-generated', task_id: taskId,
          payload: { output: { sentence_id: 1, begin_time: 0, end_time: 1800, text: '介绍一下你的项目', sentence_end: true } },
        }));
        ws.send(JSON.stringify({ message_type: 'heartbeat', task_id: taskId }));
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
  assert.equal(partials[0].segmentId, '1');
  assert.equal(partials[0].revision, 1);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, '介绍一下你的项目');
  assert.equal(finals[0].endMs, 1800);
  assert.ok(!events.some((e) => e.type === 'heartbeat'), 'heartbeat 不产生事件');
  await provider.close();
  stub.close();
});

test('[P4.2] task-failed → error 事件（带 code/message）', async () => {
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

test('[P4.2] finish-task：flush 语义（close 前 finish-task 已发送）', async () => {
  const stub = await startProtocolStub();
  const provider = new AliyunFunAsrProvider({ endpoint: stub.url, apiKey: 'sk-test', model: 'fun-asr-realtime' });
  const events = [];
  await provider.start({ sessionId: 's1', channel: 'mic', sampleRate: 16000 }, (e) => events.push(e));
  await new Promise((r) => setTimeout(r, 120));
  await provider.finish();
  assert.ok(stub.log.some((m) => m.message_type === 'finish-task'), 'finish 应发送 finish-task');
  await provider.close();
  stub.close();
});
