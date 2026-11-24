import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudioServer } from '../server/server.mjs';
import { writeBlock } from '../core/blocks.mjs';
import { listSeeds, saveSeed } from '../core/bootstrap.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

async function jsonFetch(base, path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

test('[S3.2-4] API 全链：知识库/检索/统计/practice/replay', async () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-api-'));
  const { execFileSync } = await import('node:child_process');
  execFileSync('node', [join(HERE, '..', 'cli.mjs'), 'init', '--root', t], { encoding: 'utf8' });
  // 两块：A 命中目标、B 闸门
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.api-a', revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['你如何限制查询权限？'], anchors: ['权限过滤'],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '## 30 秒版\n按角色过滤表和列。\n## 详细版\n详细。\n## 技术边界\n没做 RLS。');
  // 一个 queued 种子
  saveSeed(t, {
    seed_id: 'bbbb11111111', project_ref: null, intent_key: 'q.gap1', question: '知识缺口问题？',
    aliases: [], tracks: ['ai-app'], rounds: [], source_refs: [], fact_refs: [],
    origin_kind: 'user', status: 'queued', missing_fields: [], answer_block_id: null,
    created_at: new Date().toISOString(), revision: 1,
  });

  const srv = await createStudioServer(t, { port: 0, token: 'tok' });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const F = (path, opts = {}) => jsonFetch(base, path, { token: 'tok', ...opts });

  // 知识库
  const blocks = await F('/api/blocks');
  assert.equal(blocks.status, 200);
  assert.equal(blocks.json.blocks.length, 1);
  // 检索：hit 带内容
  const hit = await F('/api/search?q=你如何限制查询权限');
  assert.equal(hit.json.decision, 'hit');
  assert.equal(hit.json.block.block_id, 'demo.api-a');
  // 检索：candidates 不带正文
  const cand = await F('/api/search?q=怎么限制查询权限');
  assert.equal(cand.json.decision, 'candidates');
  assert.equal(cand.json.block, null);
  // bootstrap / seeds / stats
  const boot = await F('/api/bootstrap');
  assert.equal(boot.json.state, 'not_started');
  assert.ok(boot.json.seeds.length === 1);
  const stats = await F('/api/stats');
  assert.equal(stats.json.real_samples, 0);

  // practice：盲测不泄漏 → reveal 才给 → hint.revealed/rating.self 落事件
  const start = await F('/api/practice/start', { method: 'POST', body: { mode: 'mock_blind' } });
  const sid = start.json.session_id;
  const blindQ = await F(`/api/practice/${sid}/question`, { method: 'POST', body: { text: '你如何限制查询权限？' } });
  assert.equal(blindQ.json.blind, true);
  assert.equal(blindQ.json.block, undefined, '盲测 question 响应不得含块');
  const reveal = await F(`/api/practice/${sid}/reveal`, { method: 'POST', body: { question_ref: blindQ.json.question_ref } });
  assert.equal(reveal.json.block.block_id, 'demo.api-a');
  await F(`/api/practice/${sid}/rate`, { method: 'POST', body: { question_ref: blindQ.json.question_ref, score: 3, revealed: true } });
  const events = await F(`/api/sessions/${sid}`);
  assert.ok(events.json.events.some((e) => e.type === 'hint.revealed'));
  assert.ok(events.json.events.some((e) => e.type === 'rating.self'));

  // practice：full 模式 hit 直接带块
  const startFull = await F('/api/practice/start', { method: 'POST', body: { mode: 'mock_assisted' } });
  const fullQ = await F(`/api/practice/${startFull.json.session_id}/question`, { method: 'POST', body: { text: '你如何限制查询权限？' } });
  assert.equal(fullQ.json.decision, 'hit');
  assert.equal(fullQ.json.block.body.includes('按角色过滤'), true);

  // practice：anchor 模式只给锚点不给正文
  const startAnchor = await F('/api/practice/start', { method: 'POST', body: { mode: 'mock_anchor' } });
  const anchorQ = await F(`/api/practice/${startAnchor.json.session_id}/question`, { method: 'POST', body: { text: '你如何限制查询权限？' } });
  assert.equal(anchorQ.json.block.anchors.length, 1);
  assert.equal(anchorQ.json.block.body, undefined, '锚点模式不得带正文');

  // replay：纠正 role（raw 不变）+ 确认对齐
  const sessions = await F('/api/sessions');
  assert.ok(sessions.json.sessions.length >= 3);
  const wrong = await F(`/api/sessions/${sid}/correct`, { method: 'POST', body: { utterance_id: 'nope', role: 'candidate' } });
  assert.equal(wrong.status, 404);
  const finished = await F(`/api/practice/${sid}/finish`, { method: 'POST' });
  assert.equal(finished.json.ok, true);

  srv.closeAllConnections();
  await new Promise((r) => srv.close(r));
});
