import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readQuestions, listSessions } from '../core/sessions.mjs';
import { listSeeds } from '../core/bootstrap.mjs';
import { writeBlock } from '../core/blocks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');
const MD_FIXTURE = join(HERE, 'fixtures', 'transcript-fixture.md');
const REVIEW_FIXTURE = join(HERE, 'fixtures', 'review-result-fixture.json');

function runCli(args) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function tmpJson(obj) {
  const f = join(mkdtempSync(join(tmpdir(), 'ib-review-f-')), 'x.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

// 建 session + 切分 + 对齐 + 一个 active 块（含 14 节点事实供冲突对照）
function fullSession() {
  const t = mkdtempSync(join(tmpdir(), 'ib-review-'));
  runCli(['init', '--root', t]);
  const { session_id: sessionId } = JSON.parse(runCli(['transcript', 'import', '--file', MD_FIXTURE, '--root', t, '--json']).out);
  const seg = {
    results: [
      { question_id: 'q001', utterance_refs: ['u001'], kind: 'non_question' },
      { question_id: 'q002', utterance_refs: ['u002'], kind: 'question' },
      { question_id: 'q003', utterance_refs: ['u004'], kind: 'question' },
      { question_id: 'q004', utterance_refs: ['u006'], kind: 'question' },
    ],
  };
  runCli(['segment', 'apply', '--session', sessionId, '--file', tmpJson(seg), '--root', t]);
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.intro-self', revision: 1, kind: 'intro', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['先介绍一下你自己和最近做的项目吧。'],
    anchors: ['14 节点'], fact_refs: ['tech:demo.node-count'], claim_kind: 'knowledge',
    criticality: 'normal', pinned: false, source_refs: [],
  }, '## 30 秒版\n虚构：平台重构为 14 节点状态机。');
  const align = {
    results: [
      { question_id: 'q002', status: 'matched', matched_block_ids: ['demo.intro-self'], evidence_refs: ['u002'] },
      { question_id: 'q003', status: 'unmatched', matched_block_ids: [], evidence_refs: [] },
      { question_id: 'q004', status: 'matched', matched_block_ids: ['demo.intro-self'], evidence_refs: ['u006'] },
    ],
  };
  runCli(['align', 'apply', '--session', sessionId, '--file', tmpJson(align), '--root', t]);
  return { t, sessionId };
}

test('review prepare 只含 matched 问题 + 块内容 + 权重规则', () => {
  const { t, sessionId } = fullSession();
  const r = runCli(['review', 'prepare', '--session', sessionId, '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.out);
  assert.deepEqual(j.questions.map((q) => q.question_id), ['q002', 'q004']);
  assert.ok(j.questions[0].block_content.includes('14 节点'));
  assert.ok(j.questions[0].original.length >= 1);
  assert.equal(j.rubric.weights.accuracy, 30);
  assert.match(j.rubric.rules.join(' '), /unknown/);
});

test('apply fixture → review.json + review.md 渲染', () => {
  const { t, sessionId } = fullSession();
  const r = runCli(['review', 'apply', '--session', sessionId, '--file', REVIEW_FIXTURE, '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const reviewsDir = join(t, 'reviews', sessionId);
  assert.ok(existsSync(join(reviewsDir, 'review.json')));
  const md = readFileSync(join(reviewsDir, 'review.md'), 'utf8');
  assert.match(md, /原话|维度/);
  assert.match(md, /练习/);
  const j = JSON.parse(runCli(['review', 'show', '--session', sessionId, '--root', t, '--json']).out);
  assert.equal(j.summary.new_questions.length, 1);
});

test('fact_conflicts → needs_review 硬闸门，不计掌握度', () => {
  const { t, sessionId } = fullSession();
  runCli(['review', 'apply', '--session', sessionId, '--file', REVIEW_FIXTURE, '--root', t]);
  const j = JSON.parse(runCli(['review', 'show', '--session', sessionId, '--root', t, '--json']).out);
  const q004 = j.questions.find((q) => q.question_id === 'q004');
  assert.equal(q004.needs_review, true);
  assert.equal(q004.mastery_eligible, false);
  const md = readFileSync(join(t, 'reviews', sessionId, 'review.md'), 'utf8');
  assert.match(md, /事实冲突/);
});

test('维度分越界 → exit 2；evidence 引用不存在 → exit 2', () => {
  const { t, sessionId } = fullSession();
  const bad = [{
    question_id: 'q002', block_id: 'demo.intro-self',
    dimensions: {
      accuracy: { score: 5, reason: 'x', evidence_refs: ['u003'] },
      coverage: { score: 'na', reason: 'x', evidence_refs: [] },
      relevance: { score: 4, reason: 'x', evidence_refs: [] },
      clarity: { score: 3, reason: 'x', evidence_refs: [] },
      boundary_honesty: { score: 'unknown', reason: 'x', evidence_refs: [] },
    },
    fact_conflicts: [],
  }];
  let r = runCli(['review', 'apply', '--session', sessionId, '--file', tmpJson(bad), '--root', t]);
  assert.equal(r.code, 2);
  const badRef = JSON.parse(readFileSync(REVIEW_FIXTURE, 'utf8'));
  badRef[0].dimensions.accuracy.evidence_refs = ['u999'];
  r = runCli(['review', 'apply', '--session', sessionId, '--file', tmpJson(badRef), '--root', t]);
  assert.equal(r.code, 2);
});

test('unmatched → 新问题种子（origin_kind transcript, queued）+ drafts 文件', () => {
  const { t, sessionId } = fullSession();
  runCli(['review', 'apply', '--session', sessionId, '--file', REVIEW_FIXTURE, '--root', t]);
  const seeds = listSeeds(t).filter((s) => s.origin_kind === 'transcript');
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].status, 'queued');
  assert.ok(seeds[0].question.includes('路由'));
  const draftsFiles = readdirSync(join(t, 'knowledge', 'drafts')).filter((f) => f.startsWith('q-'));
  assert.equal(draftsFiles.length, 1);
});
