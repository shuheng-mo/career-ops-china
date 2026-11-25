import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { createStudioServer } from '../server/server.mjs';
import { writeBlock } from '../core/blocks.mjs';
import { createMockAsrProvider } from '../providers/asr/mock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function preparedRoot() {
  const t = mkdtempSync(join(tmpdir(), 'ib-ws-'));
  const appDir = join(HERE, '..', '..', '..', 'apps', 'interview-studio');
  mkdirSync(appDir, { recursive: true });
  if (!existsSyncIdx(join(appDir, 'index.html'))) {
    writeFileSync(join(appDir, 'index.html'), '<!doctype html><html><body>studio</body></html>');
  }
  execFileSync('node', [join(HERE, '..', 'cli.mjs'), 'init', '--root', t], { encoding: 'utf8' });
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.ws', revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['你如何限制查询权限？'], anchors: ['权限过滤'],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '## 30 秒版\n按角色过滤。\n## 详细版\n详细。\n## 技术边界\n无。');
  return t;
}
function existsSyncIdx(p) { try { readFileSync(p); return true; } catch { return false; } }

function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const msgs = [];
    ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('error', (e) => reject(e));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('[P4.5] WS：无 token 拒绝；mock provider → final → fast path hint 到达客户端', async () => {
  const t = preparedRoot();
  const srv = await createStudioServer(t, { port: 0, token: 'tok' });
  let providerRef = null;
  srv.attachWs({ token: 'tok', root: t, asrConfig: { createProvider: () => { const p = createMockAsrProvider(); providerRef = p; return p; } } });
  const port = srv.address().port;

  await assert.rejects(() => wsOpen(`ws://127.0.0.1:${port}/ws/capture`), /HTTP (401|403)/);

  const { ws, msgs } = await wsOpen(`ws://127.0.0.1:${port}/ws/capture?token=tok`);
  ws.send(JSON.stringify({ type: 'start', mode: 'mock_assisted' }));
  await wait(200);

  const pushErr = await providerRef.pushScript([
    { type: 'final', text: '你如何限制查询权限？', segmentId: 'seg1' },
  ]).then(() => null, (e) => e);
  if (pushErr) {
    throw pushErr;
  }
  await wait(2300);
  const hint = msgs.find((m) => m.type === 'hint');
  assert.ok(hint, `应收到 hint：${JSON.stringify(msgs.map((m) => ({ t: m.type, msg: m.message })))}`);
  assert.equal(hint.decision, 'hit');
  assert.equal(hint.block.block_id, 'demo.ws');

  ws.send(JSON.stringify({ type: 'stop' }));
  await wait(300);
  assert.ok(msgs.some((m) => m.type === 'state' && m.state === 'finished'), '应有 finished 状态');

  ws.close();
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
});

test('[P4.5] WS：盲测模式 hint 不含块内容', async () => {
  const t = preparedRoot();
  const srv = await createStudioServer(t, { port: 0, token: 'tok' });
  let providerRef = null;
  srv.attachWs({ token: 'tok', createProvider: () => { const p = createMockAsrProvider(); providerRef = p; console.error('[T2] createProvider called'); return p; } });
  const port = srv.address().port;
  const { ws, msgs } = await wsOpen(`ws://127.0.0.1:${port}/ws/capture?token=tok`);
  ws.send(JSON.stringify({ type: 'start', mode: 'mock_blind' }));
  await wait(300);
  console.error('[T2] providerRef:', providerRef === null ? 'NULL' : 'SET', '| msgs:', JSON.stringify(msgs));
  if (!providerRef) throw new Error('createProvider 未被调用');
  await providerRef.pushScript([
    { type: 'final', text: '你如何限制查询权限？', segmentId: 'seg1' },
  ]);
  await wait(2300);
  const hint = msgs.find((m) => m.type === 'hint');
  assert.ok(hint);
  assert.equal(hint.blind, true);
  assert.equal(hint.block, undefined);
  assert.equal(hint.decision, undefined);
  ws.close();
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
});

// ws 库的句柄在 keep-alive/半关连接下会挂住测试进程——全部测试完成后强制收尾
import { after as _after } from 'node:test';
_after(() => { setTimeout(() => process.exit(0), 300); });

test('[P4.5] WS：final 转写落盘 events.jsonl（完整文字记录）', async () => {
  const t = preparedRoot();
  const srv = await createStudioServer(t, { port: 0, token: 'tok' });
  let providerRef = null;
  srv.attachWs({ token: 'tok', root: t, asrConfig: { createProvider: () => { const p = createMockAsrProvider(); providerRef = p; return p; } } });
  const port = srv.address().port;
  const { ws, msgs } = await wsOpen(`ws://127.0.0.1:${port}/ws/capture?token=tok`);
  ws.send(JSON.stringify({ type: 'start', mode: 'mock_assisted' }));
  await wait(200);
  await providerRef.pushScript([
    { type: 'final', text: '你如何限制查询权限？', segmentId: 'seg1' },
    { type: 'final', text: '说说你的第二个项目。', segmentId: 'seg2' },
  ]);
  await wait(400);
  // 落盘：events.jsonl 应有两条 asr.final，payload.text 完整
  const sessDir = join(t, 'sessions');
  const sid = readdirSync(sessDir).find((d) => d.endsWith('.json') === false && d !== '.gitkeep' && /^[0-9a-f-]{36}$/.test(d));
  const lines = readFileSync(join(sessDir, sid, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const finals = lines.filter((e) => e.type === 'asr.final');
  assert.equal(finals.length, 2, `应有 2 条 asr.final：${lines.map((l) => l.type).join(',')}`);
  assert.equal(finals[0].payload.text, '你如何限制查询权限？');
  assert.equal(finals[1].payload.text, '说说你的第二个项目。');
  assert.equal(finals[0].payload.provider, 'mock');
  // partial 不落盘（预览态不提交事实）
  assert.ok(!lines.some((e) => e.type === 'asr.partial'), 'partial 不应落盘');
  void msgs;
  ws.close();
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
});
