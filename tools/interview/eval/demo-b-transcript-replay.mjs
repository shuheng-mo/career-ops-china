#!/usr/bin/env node
// Demo B — 逐字稿导入 → 对齐 → 复盘 → 统计 → patch（spec §12 P1.6 切片 B）
// 断言：stats 有真实 frequency；alias_add patch 应用后同义问检索 hit 且块数不增（合并去重）
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBlock, readBlocks, readBlockById } from '../core/blocks.mjs';
import { buildIndex, search } from '../retrieval/bm25.mjs';
import { decide } from '../retrieval/rank.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const CLI = join(REPO, 'tools', 'interview', 'cli.mjs');
const MD = join(REPO, 'tools', 'interview', 'test', 'fixtures', 'transcript-fixture.md');

function cli(args) {
  try {
    return JSON.parse(execFileSync('node', [CLI, ...args], { encoding: 'utf8' }));
  } catch (e) {
    console.error('CLI 失败：', args.join(' '), '\n', String(e.stdout || '') + String(e.stderr || ''));
    process.exit(1);
  }
}
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`❌ Demo B 断言失败：${msg}`);
    process.exit(1);
  }
};
const tmpJson = (obj) => {
  const f = join(mkdtempSync(join(tmpdir(), 'ib-demo-b-')), 'x.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
};

const root = mkdtempSync(join(tmpdir(), 'ib-demo-b-'));
const step = (m) => console.log(`  ${m}`);

// 1. init + 知识块（从「导入笔记」路径审批而来——直接以 writeBlock 模拟已审批块）
step('1. init + 一个已审批知识块（14 节点事实）');
cli(['init', '--root', root, '--json']);
writeBlock(root, {
  schema_version: 1, block_id: 'demo.intro-self', revision: 1, kind: 'intro', status: 'active',
  tracks: ['ai-app'], rounds: [], questions: ['先介绍一下你自己和最近做的项目吧。'],
  anchors: ['14 节点'], fact_refs: ['tech:demo.node-count'], claim_kind: 'knowledge',
  criticality: 'normal', pinned: false, source_refs: [],
}, '## 30 秒版\n虚构：平台重构为 14 节点 LangGraph 状态机。');

// 2. 逐字稿导入 + 切分 + 对齐
step('2. transcript import → segment → align');
const tx = cli(['transcript', 'import', '--file', MD, '--application', '753', '--round', '一面', '--root', root, '--json']);
assert(!tx.reused && tx.session_id, 'session 创建');
const sessionId = tx.session_id;
const seg = {
  results: [
    { question_id: 'q001', utterance_refs: ['u001'], kind: 'non_question' },
    { question_id: 'q002', utterance_refs: ['u002'], kind: 'question' },
    { question_id: 'q003', utterance_refs: ['u004'], kind: 'question' },
    { question_id: 'q004', utterance_refs: ['u006'], kind: 'question' },
  ],
};
cli(['segment', 'apply', '--session', sessionId, '--file', tmpJson(seg), '--root', root, '--json']);
const align = {
  results: [
    { question_id: 'q002', status: 'matched', matched_block_ids: ['demo.intro-self'], evidence_refs: ['u003'] },
    { question_id: 'q003', status: 'unmatched', matched_block_ids: [], evidence_refs: [] },
    { question_id: 'q004', status: 'matched', matched_block_ids: ['demo.intro-self'], evidence_refs: ['u007'] },
  ],
};
cli(['align', 'apply', '--session', sessionId, '--file', tmpJson(align), '--root', root, '--json']);

// 3. 复盘（含一个事实冲突：候选人声称 20 节点 vs 块记录 14 节点）
step('3. review apply（含事实冲突）');
const review = [
  {
    question_id: 'q002', block_id: 'demo.intro-self',
    dimensions: {
      accuracy: { score: 4, reason: '一致', evidence_refs: ['u003'] },
      coverage: { score: 3, reason: '缺量化', evidence_refs: ['u003'] },
      relevance: { score: 4, reason: '切题', evidence_refs: ['u002'] },
      clarity: { score: 3, reason: '可', evidence_refs: ['u003'] },
      boundary_honesty: { score: 'unknown', reason: '未涉及', evidence_refs: [] },
    },
    fact_conflicts: [],
    practice_action: '补量化收尾',
  },
  {
    question_id: 'q003', block_id: null,
    dimensions: {
      accuracy: { score: 'na', reason: '无块不判', evidence_refs: ['u005'] },
      coverage: { score: 'na', reason: '无块', evidence_refs: [] },
      relevance: { score: 4, reason: '切题', evidence_refs: ['u005'] },
      clarity: { score: 3, reason: '可', evidence_refs: ['u005'] },
      boundary_honesty: { score: 'unknown', reason: '未涉及', evidence_refs: [] },
    },
    fact_conflicts: [],
    new_question: '多模型路由是怎么设计的？为什么要做路由？',
    practice_action: '建路由知识块',
  },
  {
    question_id: 'q004', block_id: 'demo.intro-self',
    dimensions: {
      accuracy: { score: 1, reason: '口径冲突', evidence_refs: ['u007'] },
      coverage: { score: 2, reason: '半答', evidence_refs: ['u007'] },
      relevance: { score: 4, reason: '切题', evidence_refs: ['u006'] },
      clarity: { score: 3, reason: '可', evidence_refs: ['u007'] },
      boundary_honesty: { score: 0, reason: '把计划说成已实现', evidence_refs: ['u007'] },
    },
    fact_conflicts: [{ fact_ref: 'tech:demo.node-count', claimed: '重构成 20 个节点', actual: '知识库记录 14 节点' }],
    practice_action: '核对节点口径',
  },
];
const rv = cli(['review', 'apply', '--session', sessionId, '--file', tmpJson(review), '--root', root, '--json']);
assert(rv.needs_review === 1, '事实冲突闸门 1 条');
assert(rv.new_questions === 1, '新问题种子 1 条');

// 4. 统计：真实 frequency 出现；冲突块不计掌握度
step('4. stats');
const stats = cli(['stats', '--root', root, '--json']);
assert(stats.real_samples === 1, `real_samples=1，实际 ${stats.real_samples}`);
const b = stats.blocks.find((x) => x.block_id === 'demo.intro-self');
assert(b.frequency === 1, `frequency=1，实际 ${b.frequency}`);
assert(b.needs_review === true, '冲突块 needs_review');
assert(b.mastery === null, '冲突块 mastery=null（硬闸门）');

// 5. patch：alias_add 同义问 → 应用后同义问检索 hit、块数不变（合并去重）
step('5. alias_add patch + 同义问合并去重');
const patch = {
  type: 'alias_add',
  target_id: 'demo.intro-self',
  base_revision: 1,
  before_hash: null,
  proposed_diff: { questions_add: ['做个简单的自我介绍呗'] },
  reason: '复盘：该问法未被命中',
  source_refs: [{ artifact_id: `session:${sessionId}`, locator: 'review' }],
};
const pp = cli(['patch', 'propose', '--file', tmpJson(patch), '--root', root, '--json']);
cli(['patch', 'approve', pp.patch_id, '--root', root, '--json']);
const ap = cli(['patch', 'apply', pp.patch_id, '--root', root, '--json']);
assert(ap.status === 'applied', 'patch applied');
const blocks = readBlocks(root);
assert(blocks.length === 1, '块数不变（alias 合并进块，不建新块）');
const index = buildIndex(blocks);
const syn = search(index, '做个简单的自我介绍呗', { topK: 3 });
assert(decide('做个简单的自我介绍呗', syn, {}) === 'hit', '同义问精确命中');
// 检索路由：改写问句 → candidates（不自动跳）
const rephrase = search(index, '介绍一下你和项目', { topK: 3 });
assert(['candidates', 'unknown'].includes(decide('介绍一下你和项目', rephrase, {})), '改写问句不自动确认');

// 6. 复跑 stats 数值不变（session 已 review，不重复计数）
const stats2 = cli(['stats', '--root', root, '--json']);
assert(stats2.real_samples === 1, '重跑 stats 不重复计数');

console.log('✅ Demo B 通过：逐字稿 → 对齐 → 复盘（含冲突闸门）→ 真实统计 → patch 应用与同义问合并');
