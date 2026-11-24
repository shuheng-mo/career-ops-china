import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudioServer } from '../server/server.mjs';
import { writeBlock } from '../core/blocks.mjs';
import { computeStats } from '../core/stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function jsonFetch(base, path, { method = 'GET', body, token } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`);
    const req = http.request(u, { method, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('[I2] practice 非精确问句 → candidates（与 /api/search 一致，不再误判 unknown）', async () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-p3fix-'));
  const { execFileSync } = await import('node:child_process');
  execFileSync('node', [join(HERE, '..', 'cli.mjs'), 'init', '--root', t], { encoding: 'utf8' });
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.fix', revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['你如何限制查询权限？'], anchors: ['权限过滤'],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '## 30 秒版\n按角色过滤。');
  const srv = await createStudioServer(t, { port: 0, token: 'tok' });
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const F = (p, o = {}) => jsonFetch(base, p, { token: 'tok', ...o });
    const start = await F('/api/practice/start', { method: 'POST', body: { mode: 'mock_anchor' } });
    const q = await F(`/api/practice/${start.json.session_id}/question`, { method: 'POST', body: { text: '怎么限制查询权限' } });
    assert.equal(q.json.decision, 'candidates', `实际 ${q.json.decision}`);
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});

test('[I3] https base_url → 443 端口与 node:https 传输', async () => {
  const { requestOptionsFor } = await import('../providers/embedding.mjs');
  const opts = requestOptionsFor(new URL('https://dashscope.aliyuncs.com/compatible-mode/v1'));
  assert.equal(opts.port, 443);
  assert.equal(opts.mod, 'https');
  const opts2 = requestOptionsFor(new URL('http://127.0.0.1:9999'));
  assert.equal(opts2.port, 9999);
  assert.equal(opts2.mod, 'http');
});

test('[I4] app.js 从 URL 取 token 并清理地址栏', async () => {
  const app = readFileSync(join(HERE, '..', '..', '..', 'apps', 'interview-studio', 'app.js'), 'utf8');
  assert.ok(app.includes('URLSearchParams'), '缺 URLSearchParams');
  assert.ok(app.includes('replaceState'), '缺地址栏清理');
});

test('[I6] rate 以服务端 revealed 为准；未知 question_ref 拒绝', async () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-p3fix2-'));
  const { execFileSync } = await import('node:child_process');
  execFileSync('node', [join(HERE, '..', 'cli.mjs'), 'init', '--root', t], { encoding: 'utf8' });
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.fix2', revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['你如何限制查询权限？'], anchors: ['权限过滤'],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '## 30 秒版\n按角色过滤。');
  const srv = await createStudioServer(t, { port: 0, token: 'tok' });
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const F = (p, o = {}) => jsonFetch(base, p, { token: 'tok', ...o });
    const start = await F('/api/practice/start', { method: 'POST', body: { mode: 'mock_blind' } });
    const sid = start.json.session_id;
    const q = await F(`/api/practice/${sid}/question`, { method: 'POST', body: { text: '你如何限制查询权限？' } });
    // 伪造 revealed:true —— 服务端状态是未揭示，必须以服务端为准
    await F(`/api/practice/${sid}/rate`, { method: 'POST', body: { question_ref: q.json.question_ref, score: 4, revealed: true } });
    const detail = await F(`/api/sessions/${sid}`);
    const rating = detail.json.events.filter((e) => e.type === 'rating.self').at(-1);
    assert.equal(rating?.payload?.revealed, false, 'revealed 必须由服务端状态决定（payload 内）');
    // 未知 ref → 404
    const bad = await F(`/api/practice/${sid}/rate`, { method: 'POST', body: { question_ref: 'pq-unknown1', score: 4, revealed: true } });
    assert.equal(bad.status, 404);
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});

test('[gap] mock_blind 未揭示自评 → 独立掌握度（rating.self 接入 stats）', async () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-p3fix3-'));
  const { execFileSync } = await import('node:child_process');
  execFileSync('node', [join(HERE, '..', 'cli.mjs'), 'init', '--root', t], { encoding: 'utf8' });
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.mastery', revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['q？'], anchors: [],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '正文');
  const { createSession, appendEvent } = await import('../core/sessions.mjs');
  const s = createSession(t, { mode: 'mock_blind', source: 'practice' });
  const qref = 'pq-abc';
  appendEvent(t, s.session_id, { type: 'question.detected', payload: { question_ref: qref, block: 'demo.mastery' } });
  appendEvent(t, s.session_id, { type: 'rating.self', payload: { question_ref: qref, score: 3, revealed: false, block: 'demo.mastery' } });
  const stats = computeStats(t, {});
  const m = stats.blocks.find((b) => b.block_id === 'demo.mastery');
  assert.equal(stats.real_samples, 0, 'practice 不进频率分母');
  assert.ok(Math.abs(m.mastery - 0.75) < 0.01, `mastery=${m.mastery} 应为 0.75`);
});
