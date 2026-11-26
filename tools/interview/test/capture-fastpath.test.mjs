import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { FastPath } from '../server/capture-fastpath.mjs';
import { writeBlock } from '../core/blocks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');

function preparedRoot() {
  const t = mkdtempSync(join(tmpdir(), 'ib-fastpath-'));
  execFileSync('node', [CLI, 'init', '--root', t], { encoding: 'utf8' });
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.fp', revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['你如何限制查询权限？'], anchors: ['权限过滤'],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '## 30 秒版\n按角色过滤。\n## 详细版\n详细内容。');
  return t;
}

function finalEvent(text) {
  return { type: 'final', provider: 'mock', streamId: 'st1', segmentId: `seg-${Math.random().toString(36).slice(2, 6)}`, revision: 1, channel: 'mic', startMs: 0, endMs: 1000, text };
}

test('[P4.4] partial 不产生定位；final 问题 → hit 提交（带 generation token）', async () => {
  const t = preparedRoot();
  const fp = new FastPath(t, { mode: 'mock_assisted' });
  const r1 = await fp.onAsrEvent({ ...finalEvent('嗯那个好的'), channel: 'mic' });
  assert.equal(r1, null, '非问题文本不触发');
  await fp.onAsrEvent({ ...finalEvent('你如何限制查询权限？'), channel: 'mic' });
  // 稳定期 2000ms 前不提交
  assert.equal(fp.lastSubmission, null, '稳定期内不提交');
  await new Promise((r) => setTimeout(r, 2100));
  assert.ok(fp.lastSubmission, '稳定期后提交');
  assert.equal(fp.lastSubmission.decision, 'hit');
  assert.equal(fp.lastSubmission.block.block_id, 'demo.fp');
  assert.ok(fp.lastSubmission.generationToken, '带 generation token');
});

test('[P4.4] partial 事件永不触发定位', async () => {
  const t = preparedRoot();
  const fp = new FastPath(t, { mode: 'mock_assisted' });
  const r = await fp.onAsrEvent({ type: 'partial', provider: 'mock', streamId: 'st', segmentId: 's1', revision: 1, channel: 'mic', text: '怎样防止越权读取数据？' });
  assert.equal(r, null);
  await new Promise((r2) => setTimeout(r2, 2100));
  assert.equal(fp.lastSubmission, null);
});

test('[P4.4] 候选人回答（channel=remote）不触发', async () => {
  const t = preparedRoot();
  const fp = new FastPath(t, { mode: 'mock_assisted' });
  await fp.onAsrEvent({ ...finalEvent('我按角色过滤表和列'), channel: 'remote' });
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal(fp.lastSubmission, null);
});

test('[P4.4] 锁定后禁止自动跳', async () => {
  const t = preparedRoot();
  const fp = new FastPath(t, { mode: 'mock_assisted' });
  fp.setLocked(true);
  await fp.onAsrEvent(finalEvent('那你说说怎样防止越权读取数据？'));
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal(fp.lastSubmission, null, '锁定时不自动提交');
  assert.ok(fp.suppressed.length >= 1, '被抑制的提交有记录');
});

test('[P4.4] 新问题取消旧提交（generation token 过时丢弃）', async () => {
  const t = preparedRoot();
  const fp = new FastPath(t, { mode: 'mock_assisted' });
  const p1 = await fp.onAsrEvent(finalEvent('那你说说怎样防止越权读取数据？'));
  const token1 = p1.generationToken;
  // 立刻来一个新问题（同 streamId 连续）→ 旧 token 作废
  const p2 = await fp.onAsrEvent(finalEvent('那多模型路由是怎么设计的？'));
  assert.ok(token1 !== p2.generationToken);
  await new Promise((r) => setTimeout(r, 2100));
  // 旧 token 的延迟提交必须被丢弃（只留最新）
  assert.ok(fp.lastSubmission == null || fp.lastSubmission.generationToken === p2.generationToken);
});

test('[P4.4] 同 block 600ms 防抖：连续追问不重复跳', async () => {
  const t = preparedRoot();
  const fp = new FastPath(t, { mode: 'mock_assisted' });
  const a = await fp.onAsrEvent(finalEvent('你如何限制查询权限？'));
  assert.ok(a);
  // 600ms 内再来一个同块问题（追问）
  const before = fp.lastSubmissionCount;
  await fp.onAsrEvent(finalEvent('那你具体怎么做的权限过滤呢？'));
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(fp.lastSubmissionCount, before, '同块 600ms 内不重复提交');
});

test('[P4.4] 盲测模式不回传块内容', async () => {
  const t = preparedRoot();
  const fp = new FastPath(t, { mode: 'mock_blind' });
  const r = await fp.onAsrEvent(finalEvent('那你说说怎样防止越权读取数据？'));
  assert.ok(r);
  assert.equal(r.blind, true);
  assert.equal(r.block, undefined);
  assert.equal(r.decision, undefined, '盲测不回传 decision');
});

test('[F.lock] 锁定后 onAsrEvent 直接返回 null（hint 不外发，e2e 实锤路径）', async () => {
  const { FastPath } = await import('../server/capture-fastpath.mjs');
  const { writeBlock } = await import('../core/blocks.mjs');
  const t = mkdtempSync(join(tmpdir(), 'ib-fp-'));
  execFileSync('node', [join(HERE, '..', 'cli.mjs'), 'init', '--root', t], { encoding: 'utf8' });
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.lock', revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['你的搜索架构是什么？'], anchors: [],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '## 30 秒版\n混合检索。');
  const fp = new FastPath(t, { mode: 'mock_assisted' });
  const h1 = await fp.onAsrEvent({ type: 'final', text: '你的搜索架构是什么？', channel: 'mic', streamId: 's1', segmentId: '1', revision: 1 });
  assert.ok(h1, '未锁定时应返回 handle');
  fp.setLocked(true);
  const h2 = await fp.onAsrEvent({ type: 'final', text: '讲一下你的项目背景？', channel: 'mic', streamId: 's1', segmentId: '2', revision: 1 });
  assert.equal(h2, null, '锁定后 onAsrEvent 必须返回 null（server 据此不发 hint）');
  assert.ok(fp.suppressed.some((s) => s.reason === 'locked'), '应记 suppressed');
  fp.dispose();
});

test('[P4.4] real_record_only：真实面试仅记录——问题不触发检索/提词/提交', async () => {
  const t = preparedRoot();
  const fp = new FastPath(t, { mode: 'real_record_only' });
  const r = await fp.onAsrEvent({ ...finalEvent('你如何限制查询权限？'), channel: 'mic' });
  assert.equal(r, null, 'real_record_only 不返回 handle（不产生 hint）');
  await new Promise((res) => setTimeout(res, 2100));
  assert.equal(fp.lastSubmission, null, 'real_record_only 不提交定位');
});
