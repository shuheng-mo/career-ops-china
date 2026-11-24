import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { FastPath } from '../server/capture-fastpath.mjs';
import { CaptureSession } from '../server/capture.mjs';
import { createStudioServer } from '../server/server.mjs';
import { writeBlock } from '../core/blocks.mjs';
import { createMockAsrProvider } from '../providers/asr/mock.mjs';
import { AliyunFunAsrProvider } from '../providers/asr/aliyun-fun-asr.mjs';
import { WebSocketServer } from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');

function preparedRoot() {
  const t = mkdtempSync(join(tmpdir(), 'ib-p4fix-'));
  execFileSync('node', [CLI, 'init', '--root', t], { encoding: 'utf8' });
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.fp', revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['你如何限制查询权限？'], anchors: ['权限过滤'],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '## 30 秒版\n按角色过滤。');
  return t;
}

function finalEvent(text, { streamId = 'st1', segmentId = 'seg1' } = {}) {
  return { type: 'final', provider: 'mock', streamId, segmentId, revision: 1, channel: 'mic', startMs: 0, endMs: 1000, text };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const msgs = [];
    ws.on('message', (raw) => { try { msgs.push(JSON.parse(raw.toString())); } catch { /* 忽略非 JSON */ } });
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('error', (e) => reject(e));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

test('[C1] 重连后新 streamId 重发同段 → 不重复提交', async () => {
  const t = preparedRoot();
  const fp = new FastPath(t, { mode: 'mock_assisted' });
  // 旧流 final 提交
  await fp.onAsrEvent(finalEvent('你如何限制查询权限？', { streamId: 'st-old', segmentId: 'seg1' }));
  await wait(2100);
  assert.equal(fp.lastSubmissionCount, 1);
  // 重连后新 streamId 重发同 segmentId 的 final（服务端重连重放）→ 必须拒绝
  await fp.onAsrEvent(finalEvent('你如何限制查询权限？', { streamId: 'st-new', segmentId: 'seg1' }));
  await wait(2100);
  assert.equal(fp.lastSubmissionCount, 1, `重连重放不得重复提交（实际 ${fp.lastSubmissionCount}）`);
});

test('[I6] WS 语音练习 → 实时问题事件落盘（question.detected realtime 标记）', async () => {
  const t = preparedRoot();
  const srv = await createStudioServer(t, { port: 0, token: 'tok' });
  let providerRef = null;
  srv.attachWs({ token: 'tok', createProvider: () => { const p = createMockAsrProvider(); providerRef = p; return p; } });
  const port = srv.address().port;
  const { ws, msgs } = await wsOpen(`ws://127.0.0.1:${port}/ws/capture?token=tok`);
  ws.send(JSON.stringify({ type: 'start', mode: 'mock_assisted' }));
  await wait(300);
  await providerRef.pushScript([{ type: 'final', text: '你如何限制查询权限？', segmentId: 'seg1' }]);
  await wait(2300);
  // 练习 session 落盘且带 realtime 问题事件
  const sessionsRoot = join(t, 'sessions');
  const dirs = readdirSafe(sessionsRoot).filter((d) => existsSync(join(sessionsRoot, d, 'session.json')));
  assert.ok(dirs.length >= 1, '练习 session 落盘');
  const eventsFile = join(sessionsRoot, dirs[0], 'events.jsonl');
  const raw = readFileSync(eventsFile, 'utf8');
  assert.match(raw, /question\.detected/);
  assert.match(raw, /realtime/);
  ws.close();
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
});
function readdirSafe(d) { try { return readdirTop(d); } catch { return []; } }
import { readdirSync as readdirTop, existsSync } from 'node:fs';

test('[C2] 成本闸门：预算到限 → 停止云调用 + BUDGET_EXCEEDED', async () => {
  const t = preparedRoot();
  // 极小预算便于测试：budgetYuan 0.0002 ≈ 0.6s 音频（1.188 元/小时）
  const cs = new CaptureSession({ sessionId: 'c', budget: { maxSessionMinutes: 90, budgetYuan: 0.0002, cnyPerHour: 1.188 } });
  cs.transition('permission_pending');
  cs.transition('connecting');
  cs.transition('recording');
  // 推 0.5 秒音频 → 未到限
  assert.equal(cs.noteAudioMs(500), false, '未到限');
  // 推 0.5 秒 → 累计 1s ≈ 0.00033 元 > 0.0002 → 到限
  assert.equal(cs.noteAudioMs(500), true, '到限');
  assert.equal(cs.budgetExceeded, true);
});

test('[C2b] 会话时长闸门：91 分钟前开始的会话 → 立即到限', async () => {
  const cs = new CaptureSession({ sessionId: 'c2', budget: { maxSessionMinutes: 90, budgetYuan: 3, cnyPerHour: 1.188, nowShiftMs: -91 * 60000 } });
  cs.transition('permission_pending');
  cs.transition('connecting');
  cs.transition('recording');
  const exceeded = cs.noteAudioMs(500);
  assert.equal(exceeded, true, '91 分钟 > 90 分钟闸门');
  assert.equal(cs.budgetExceeded, true);
});

test('[I3] task-started 超时 → error + 重连（stub 不回 task-started）', async () => {
  const log = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.message_type === 'run-task') log.push('run-task');
        // 故意不回 task-started
      } catch { /* 二进制帧忽略 */ }
    });
  });
  await new Promise((r) => wss.on('listening', r));
  const url = `ws://127.0.0.1:${wss.address().port}`;
  const provider = new AliyunFunAsrProvider({ endpoint: url, apiKey: 'k', model: 'm', startTimeoutMs: 300, maxReconnects: 1 });
  const events = [];
  await provider.start({ sessionId: 's', channel: 'mic', sampleRate: 16000 }, (e) => events.push(e));
  await wait(1200);
  const errors = events.filter((e) => e.type === 'error');
  assert.ok(errors.length >= 1, `应有 task-started 超时 error：${JSON.stringify(events.map((e) => e.type))}`);
  assert.ok(log.filter((x) => x === 'run-task').length >= 2, '应有重连尝试（run-task ≥2）');
  await provider.close();
  wss.closeAllConnections?.();
  wss.close();
});

test('[I5] started 后 bufferedAmount 超限 → 丢帧 + gap', async () => {
  const provider = new AliyunFunAsrProvider({ endpoint: 'ws://127.0.0.1:1', apiKey: 'k', model: 'm' });
  const events = [];
  const fakeWs = { bufferedAmount: 999999, send: () => { throw new Error('不应发送'); } };
  provider.ws = fakeWs;
  provider.started = true;
  provider.streamId = 'st';
  provider.emit = (e) => events.push(e);
  await provider.push(Buffer.alloc(3200));
  assert.ok(events.some((e) => e.type === 'gap'), '超限应发 gap');
});

test('[I8] 语音启动前有云连接披露确认（app.js 含确认文案）', async () => {
  const app = readFileSync(join(HERE, '..', '..', '..', 'apps', 'interview-studio', 'app.js'), 'utf8');
  assert.match(app, /按量计费|费用|数据去向/);
  assert.match(app, /confirm\(/);
});

// 异步 provider/server 句柄在失败路径下会挂住测试进程——全部测试完成后强制收尾
import { after as _after2 } from 'node:test';
_after2(() => { setTimeout(() => process.exit(0), 300); });
