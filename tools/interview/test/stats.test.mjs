import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStats } from '../core/stats.mjs';
import { writeBlock } from '../core/blocks.mjs';
import { appendSignal } from '../core/signals.mjs';
import { createSession, saveQuestions, appendEvent } from '../core/sessions.mjs';
import { resolveRoot, atomicWriteJson } from '../core/storage.mjs';
import { mkdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');

function runCli(args) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function blockFm(blockId, extra = {}) {
  return {
    schema_version: 1, block_id: blockId, revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: [`问题 ${blockId}？`], anchors: [],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false,
    source_refs: [], ...extra,
  };
}

// 手工造一场 session：questions（对齐 matched）+ review.json
function craftSession(t, { mode, blockId, questionScore, questionId = 'q001', needsReview = false, utteranceRefs = ['u001'] }) {
  const s = createSession(t, { mode, source: 'craft' });
  saveQuestions(t, s.session_id, [{
    question_id: questionId,
    utterance_refs: utteranceRefs,
    kind: 'question',
    text: `问题 ${blockId}？`,
    alignment: { status: 'matched', matched_block_ids: [blockId], evidence_refs: utteranceRefs },
  }]);
  const dims = {};
  for (const d of ['accuracy', 'coverage', 'relevance', 'clarity', 'boundary_honesty']) {
    dims[d] = { score: typeof questionScore === 'number' ? questionScore : (d === 'accuracy' ? 1 : 3), reason: 'craft', evidence_refs: utteranceRefs };
  }
  const review = {
    schema_version: 1,
    session_id: s.session_id,
    application_num: null,
    round: null,
    rubric_version: 'rubric-v1-2026-11-24',
    reviewed_at: new Date().toISOString(),
    questions: [{
      question_id: questionId,
      block_id: blockId,
      needs_review: needsReview,
      mastery_eligible: !needsReview,
      dimensions: dims,
      fact_conflicts: needsReview ? [{ fact_ref: 'x', claimed: 'c', actual: 'a' }] : [],
      practice_action: null,
      new_question: null,
    }],
    summary: { top_improvements: [], needs_review: needsReview ? [questionId] : [], new_questions: [] },
  };
  const { paths } = resolveRoot(t);
  mkdirSync(join(paths.reviewsDir, s.session_id), { recursive: true });
  atomicWriteJson(join(paths.reviewsDir, s.session_id, 'review.json'), review);
  return s;
}

let _fs;
function require_fs() {
  return _fs ||= {};
}

test('只有 predicted 信号 → frequency/mastery 全 null + real_samples 0', () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-stats-'));
  runCli(['init', '--root', t]);
  writeBlock(t, blockFm('demo.solo'), '正文');
  appendSignal(t, { kind: 'predicted', source_kind: 'manual', source_ref: 'x', intent_key: 'm.x' });
  const stats = computeStats(t, {});
  const solo = stats.blocks.find((b) => b.block_id === 'demo.solo');
  assert.equal(solo.frequency, null);
  assert.equal(solo.mastery, null);
  assert.equal(stats.real_samples, 0);
  assert.match(stats.note, /暂无真实面试样本/);
});

test('real session 命中 + mock_blind 打分：frequency=1/1（规格 §6.1），mastery≈0.75，assisted 分开', () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-stats-2-'));
  runCli(['init', '--root', t]);
  writeBlock(t, blockFm('demo.a'), '正文');
  craftSession(t, { mode: 'historical_import', blockId: 'demo.a', questionScore: 3 }); // 真实命中（同为独立回答）
  craftSession(t, { mode: 'mock_blind', blockId: 'demo.a', questionScore: 3 });
  craftSession(t, { mode: 'mock_assisted', blockId: 'demo.a', questionScore: 4 });
  const stats = computeStats(t, {});
  const a = stats.blocks.find((b) => b.block_id === 'demo.a');
  assert.equal(stats.real_samples, 1);
  assert.equal(a.frequency, 1); // distinct_hit 1 / eligible 1
  assert.equal(a.low_sample, true);
  assert.ok(Math.abs(a.mastery - 0.75) < 0.01, `mastery=${a.mastery}`);
  assert.ok(Math.abs(a.mastery_assisted - 1) < 0.01, `assisted=${a.mastery_assisted}`);
});

test('同 session 同块两问只计 1 次 hit', () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-stats-3-'));
  runCli(['init', '--root', t]);
  writeBlock(t, blockFm('demo.b'), '正文');
  const s = craftSession(t, { mode: 'historical_import', blockId: 'demo.b', questionScore: null });
  saveQuestions(t, s.session_id, [
    { question_id: 'q001', utterance_refs: ['u001'], kind: 'question', text: 'b 问一', alignment: { status: 'matched', matched_block_ids: ['demo.b'], evidence_refs: ['u001'] } },
    { question_id: 'q002', utterance_refs: ['u001'], kind: 'followup', text: 'b 追问', alignment: { status: 'matched', matched_block_ids: ['demo.b'], evidence_refs: ['u001'] } },
  ]);
  const stats = computeStats(t, {});
  const b = stats.blocks.find((x) => x.block_id === 'demo.b');
  assert.equal(b.hits, 1);
  assert.equal(b.frequency, 1);
});

test('事实冲突块 → mastery null + needs_review', () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-stats-4-'));
  runCli(['init', '--root', t]);
  writeBlock(t, blockFm('demo.c'), '正文');
  craftSession(t, { mode: 'mock_blind', blockId: 'demo.c', questionScore: 4, needsReview: true });
  const stats = computeStats(t, {});
  const c = stats.blocks.find((x) => x.block_id === 'demo.c');
  assert.equal(c.mastery, null);
  assert.equal(c.needs_review, true);
});

test('重复 review（覆盖写）→ stats 数值不变', () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-stats-5-'));
  runCli(['init', '--root', t]);
  writeBlock(t, blockFm('demo.d'), '正文');
  craftSession(t, { mode: 'historical_import', blockId: 'demo.d', questionScore: null });
  const s1 = computeStats(t, {});
  craftSession(t, { mode: 'historical_import', blockId: 'demo.d', questionScore: null });
  const s2 = computeStats(t, {});
  assert.equal(s2.real_samples, s1.real_samples + 1); // 新 session 算新样本
  const d1 = s1.blocks.find((b) => b.block_id === 'demo.d');
  const d2 = s2.blocks.find((b) => b.block_id === 'demo.d');
  assert.equal(d2.hits, d1.hits + 1); // 每个 session 命中一次
});

test('CLI stats --json 可运行', () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-stats-6-'));
  runCli(['init', '--root', t]);
  const r = runCli(['stats', '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(r.out).real_samples, 0);
});

function require_fs_guard() {}
