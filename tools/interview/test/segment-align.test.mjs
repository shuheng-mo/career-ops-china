import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readQuestions, readEvents } from '../core/sessions.mjs';
import { writeBlock } from '../core/blocks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');
const MD_FIXTURE = join(HERE, 'fixtures', 'transcript-fixture.md');

function runCli(args) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function tmpJson(obj) {
  const f = join(mkdtempSync(join(tmpdir(), 'ib-seg-f-')), 'x.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

function sessionWithUtterances() {
  const t = mkdtempSync(join(tmpdir(), 'ib-seg-'));
  runCli(['init', '--root', t]);
  const r = JSON.parse(runCli(['transcript', 'import', '--file', MD_FIXTURE, '--root', t, '--json']).out);
  return { t, sessionId: r.session_id };
}

// fixture 逐字稿 7 条：寒暄(1) + 问(2) 答(3) 问(4) 答(5) 问(6) 答(7)
const SEGMENTATION = {
  results: [
    { question_id: 'q001', utterance_refs: ['u001'], kind: 'non_question' },
    { question_id: 'q002', utterance_refs: ['u002'], kind: 'question' },
    { question_id: 'q003', utterance_refs: ['u004'], kind: 'question' },
    { question_id: 'q004', utterance_refs: ['u006'], kind: 'question' },
  ],
};

function approveTestBlock(t, blockId = 'demo.intro-self') {
  writeBlock(t, {
    schema_version: 1, block_id: blockId, revision: 1, kind: 'intro', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['先介绍一下你自己和最近做的项目吧。'], anchors: [],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '## 30 秒版\n虚构介绍。');
}

test('segment apply → questions.json；引用不存在的 utterance → exit 2', () => {
  const { t, sessionId } = sessionWithUtterances();
  let r = runCli(['segment', 'apply', '--session', sessionId, '--file', tmpJson(SEGMENTATION), '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const qs = readQuestions(t, sessionId);
  assert.equal(qs.length, 3); // non_question 不入题队列
  assert.ok(qs[0].text.includes('项目'));
  const bad = { results: [{ question_id: 'qX', utterance_refs: ['u999'], kind: 'question' }] };
  r = runCli(['segment', 'apply', '--session', sessionId, '--file', tmpJson(bad), '--root', t]);
  assert.equal(r.code, 2);
});

test('重复 segment apply 同文件 → 幂等（questions 不翻倍、事件不重复）', () => {
  const { t, sessionId } = sessionWithUtterances();
  const f = tmpJson(SEGMENTATION);
  runCli(['segment', 'apply', '--session', sessionId, '--file', f, '--root', t]);
  const eventsBefore = readEvents(t, sessionId).filter((e) => e.type === 'question.detected').length;
  runCli(['segment', 'apply', '--session', sessionId, '--file', f, '--root', t, '--json']);
  const qs = readQuestions(t, sessionId);
  assert.equal(qs.length, 3);
  const eventsAfter = readEvents(t, sessionId).filter((e) => e.type === 'question.detected').length;
  assert.equal(eventsAfter, eventsBefore);
  assert.equal(eventsBefore, 3);
});

test('align apply：matched 指向不存在块 → exit 2；无 evidence → exit 2；ambiguous 合法', () => {
  const { t, sessionId } = sessionWithUtterances();
  approveTestBlock(t);
  runCli(['segment', 'apply', '--session', sessionId, '--file', tmpJson(SEGMENTATION), '--root', t]);
  // matched 不存在的块
  let r = runCli(['align', 'apply', '--session', sessionId, '--file', tmpJson({
    results: [{ question_id: 'q002', status: 'matched', matched_block_ids: ['no.such-block'], evidence_refs: ['u002'] }],
  }), '--root', t]);
  assert.equal(r.code, 2);
  // matched 无 evidence_refs
  r = runCli(['align', 'apply', '--session', sessionId, '--file', tmpJson({
    results: [{ question_id: 'q002', status: 'matched', matched_block_ids: ['demo.intro-self'], evidence_refs: [] }],
  }), '--root', t]);
  assert.equal(r.code, 2);
  // ambiguous 合法
  r = runCli(['align', 'apply', '--session', sessionId, '--file', tmpJson({
    results: [
      { question_id: 'q002', status: 'ambiguous', matched_block_ids: ['demo.intro-self'], evidence_refs: ['u002'] },
      { question_id: 'q003', status: 'unmatched', matched_block_ids: [], evidence_refs: [] },
    ],
  }), '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const qs = readQuestions(t, sessionId);
  assert.equal(qs.find((q) => q.question_id === 'q002').alignment.status, 'ambiguous');
  assert.equal(qs.find((q) => q.question_id === 'q003').alignment.status, 'unmatched');
});

test('align export 附检索候选（topK）', () => {
  const { t, sessionId } = sessionWithUtterances();
  approveTestBlock(t);
  runCli(['segment', 'apply', '--session', sessionId, '--file', tmpJson(SEGMENTATION), '--root', t]);
  const r = runCli(['align', 'export', '--session', sessionId, '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.out);
  assert.ok(j.questions.length >= 3);
  const q002 = j.questions.find((q) => q.question_id === 'q002');
  assert.ok(Array.isArray(q002.candidates));
});
