import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { createStudioServer } from '../server/server.mjs';
import { writeBlock } from '../core/blocks.mjs';
import { createMockAsrProvider } from '../providers/asr/mock.mjs';
import { createSession, getSession, readEvents } from '../core/sessions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function preparedRoot() {
  const t = mkdtempSync(join(tmpdir(), 'ib-empty-'));
  execFileSync('node', [join(HERE, '..', 'cli.mjs'), 'init', '--root', t], { encoding: 'utf8' });
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.empty', revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['你如何限制查询权限？'], anchors: ['权限过滤'],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '## 30 秒版\n按角色过滤。\n## 详细版\n详细。\n## 技术边界\n无。');
  return t;
}

const fetchWithClose = (url, init = {}) => fetch(url, { ...init, headers: { Connection: 'close', ...(init.headers || {}) } });

async function jsonFetch(base, path, { method = 'GET', body, token } = {}) {
  const res = await fetchWithClose(`${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`, {
    method,
    headers: { Connection: 'close', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('空练习（零提问零评分）finish → discarded:true 且 session 删除', async () => {
  const t = preparedRoot();
  const srv = await createStudioServer(t, { port: 0, token: 'tok' });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const start = await jsonFetch(base, '/api/practice/start', { method: 'POST', body: { mode: 'mock_assisted' }, token: 'tok' });
  const sid = start.json.session_id;
  const fin = await jsonFetch(base, `/api/practice/${sid}/finish`, { method: 'POST', token: 'tok' });
  assert.equal(fin.status, 200);
  assert.equal(fin.json.discarded, true);
  assert.equal(getSession(t, sid), null, '空场 session 应被删除');
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
});

test('有提问的练习 finish → 保留 + session.finished 事件', async () => {
  const t = preparedRoot();
  const srv = await createStudioServer(t, { port: 0, token: 'tok' });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const start = await jsonFetch(base, '/api/practice/start', { method: 'POST', body: { mode: 'mock_assisted' }, token: 'tok' });
  const sid = start.json.session_id;
  await jsonFetch(base, `/api/practice/${sid}/question`, { method: 'POST', body: { text: '你如何限制查询权限？' }, token: 'tok' });
  const fin = await jsonFetch(base, `/api/practice/${sid}/finish`, { method: 'POST', token: 'tok' });
  assert.equal(fin.json.discarded, undefined, '有内容的场不得被丢弃');
  assert.ok(getSession(t, sid), 'session 应保留');
  assert.ok(readEvents(t, sid).some((e) => e.type === 'session.finished'));
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
});

test('非 studio 来源（真实复盘导入）finish → 绝不删除', async () => {
  const t = preparedRoot();
  const real = createSession(t, { mode: 'historical_import', source: 'import' });
  const srv = await createStudioServer(t, { port: 0, token: 'tok' });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const fin = await jsonFetch(base, `/api/practice/${real.session_id}/finish`, { method: 'POST', token: 'tok' });
  assert.equal(fin.json.discarded, undefined);
  assert.ok(getSession(t, real.session_id), '真实数据 session 不得被 finish 删除');
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
});

test('语音空场（start→stop 无音频无问题）→ stop 返回 discarded 且 session 删除', async () => {
  const t = preparedRoot();
  const srv = await createStudioServer(t, { port: 0, token: 'tok' });
  srv.attachWs({ token: 'tok', root: t, asrConfig: { createProvider: () => createMockAsrProvider() } });
  const port = srv.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/capture?token=tok`);
  const msgs = [];
  ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'start', mode: 'mock_assisted' }));
  await wait(300);
  const { readdirSync } = await import('node:fs');
  const before = readdirSync(join(t, 'sessions')).filter((d) => d.includes('-')).length;
  assert.equal(before, 1, 'start 后应有一个 session 目录');
  ws.send(JSON.stringify({ type: 'stop' }));
  await wait(300);
  const stateMsg = msgs.filter((m) => m.type === 'state' && m.state === 'finished').pop();
  assert.equal(stateMsg.discarded, true, 'stop 应返回 discarded:true');
  const after = readdirSync(join(t, 'sessions')).filter((d) => d.includes('-')).length;
  assert.equal(after, 0, '空语音场 session 应被删除');
  ws.close();
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
});

test('Replay 列表过滤未结束的空场（用户直接关页的遗留）', async () => {
  const t = preparedRoot();
  const srv = await createStudioServer(t, { port: 0, token: 'tok' });
  const base = `http://127.0.0.1:${srv.address().port}`;
  await jsonFetch(base, '/api/practice/start', { method: 'POST', body: { mode: 'mock_assisted' }, token: 'tok' });
  const sess = await jsonFetch(base, '/api/sessions', { token: 'tok' });
  assert.equal(sess.json.sessions.length, 0, '无内容的空场不应出现在 Replay 列表');
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
});

test('语音有转写的场 stop → 保留 + session.finished 落盘', async () => {
  const t = preparedRoot();
  const srv = await createStudioServer(t, { port: 0, token: 'tok' });
  let providerRef = null;
  srv.attachWs({ token: 'tok', root: t, asrConfig: { createProvider: () => { const p = createMockAsrProvider(); providerRef = p; return p; } } });
  const port = srv.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/capture?token=tok`);
  const msgs = [];
  ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'start', mode: 'mock_assisted' }));
  await wait(200);
  await providerRef.pushScript([{ type: 'final', text: '你如何限制查询权限？', segmentId: 'seg1' }]);
  await wait(300);
  ws.send(JSON.stringify({ type: 'stop' }));
  await wait(400);
  const { readdirSync } = await import('node:fs');
  const sid = readdirSync(join(t, 'sessions')).find((d) => d.includes('-'));
  assert.ok(sid, '有内容的语音场应保留');
  const types = readEvents(t, sid).map((e) => e.type);
  assert.ok(types.includes('asr.final'));
  assert.ok(types.includes('session.finished'), `stop 应落 session.finished，实际事件：${types.join(',')}`);
  ws.close();
  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
});

// ws 库的句柄在 keep-alive/半关连接下会挂住测试进程——全部测试完成后强制收尾
import { after } from 'node:test';
after(() => { setTimeout(() => process.exit(0), 300); });

test('/api/sessions：人性化标题 + 事件计数 + 时间倒序', async () => {
  const t = preparedRoot();
  const real = createSession(t, { mode: 'historical_import', source: 'import', applicationNum: 461, round: '一面' });
  const older = createSession(t, { mode: 'mock_assisted', source: 'studio-practice' });
  const { appendEvent } = await import('../core/sessions.mjs');
  appendEvent(t, older.session_id, { type: 'question.detected', payload: { question_text: '测试' } }); // 有内容才不会被空场过滤
  // 让 older 时间戳更早：直接改写 created_at
  const { writeFileSync } = await import('node:fs');
  const sess = JSON.parse((await import('node:fs')).readFileSync(join(t, 'sessions', older.session_id, 'session.json'), 'utf8'));
  sess.created_at = '2026-01-01T00:00:00.000Z';
  writeFileSync(join(t, 'sessions', older.session_id, 'session.json'), JSON.stringify(sess));
  const srv = await createStudioServer(t, { port: 0, token: 'tok' });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const r = await jsonFetch(base, '/api/sessions', { token: 'tok' });
  const list = r.json.sessions;
  assert.equal(list.length, 2);
  const bySrc = Object.fromEntries(list.map((s) => [s.source, s]));
  assert.match(bySrc.import.title, /真实面试 · #461 · 一面/, `标题应人性化：${bySrc.import.title}`);
  assert.match(bySrc['studio-practice'].title, /文字练习 · 完整提词/, `练习标题：${bySrc['studio-practice'].title}`);
  assert.ok(list[0].created_at >= list[1].created_at, '应按时间倒序');
  assert.deepEqual(bySrc.import.counts, { q: 0, rate: 0, finals: 0, finished: false });
  srv.closeAllConnections();
  await new Promise((res) => srv.close(res));
});
