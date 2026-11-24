import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSeeds } from '../core/bootstrap.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');
const CV_FIXTURE = join(HERE, 'fixtures', 'cv-fixture.md');

function runCli(args) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function preparedRoot() {
  const t = mkdtempSync(join(tmpdir(), 'ib-dig-'));
  runCli(['init', '--root', t]);
  runCli(['bootstrap', '--from', 'cv', '--cv', CV_FIXTURE, '--root', t]);
  return t;
}

function tmpJson(obj) {
  const f = join(mkdtempSync(join(tmpdir(), 'ib-dig-r-')), 'result.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('dig prepare 取前 5 个 queued（intro 优先），第 6 个不出现', () => {
  const t = preparedRoot();
  const r = runCli(['dig', 'prepare', '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.out);
  assert.ok(j.questions.length <= 5);
  assert.equal(j.questions[0].intent_key, 'intro.self');
  const intents = j.questions.map((q) => q.intent_key);
  const storyIdx = intents.findIndex((k) => k.endsWith('.story'));
  const boundaryIdx = intents.findIndex((k) => k.endsWith('.boundary'));
  if (storyIdx >= 0 && boundaryIdx >= 0) assert.ok(storyIdx < boundaryIdx);
});

test('ingest 各状态转移：answered/unclear/not_done/skipped', () => {
  const t = preparedRoot();
  const p = runCli(['dig', 'prepare', '--root', t, '--json']);
  const qs = JSON.parse(p.out).questions;
  const [q1, q2, q3, q4] = qs;
  const f = tmpJson({
    results: [
      { seed_id: q1.seed_id, status: 'answered', raw_answer: '我的原话答案，一字不改。' },
      { seed_id: q2.seed_id, status: 'unclear' },
      { seed_id: q3.seed_id, status: 'not_done' },
      { seed_id: q4.seed_id, status: 'skipped' },
    ],
  });
  const r = runCli(['dig', 'ingest', '--file', f, '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const seeds = listSeeds(t);
  const byId = Object.fromEntries(seeds.map((s) => [s.seed_id, s]));
  assert.equal(byId[q1.seed_id].status, 'draft_ready');
  assert.equal(byId[q2.seed_id].status, 'needs_input');
  assert.equal(byId[q3.seed_id].status, 'dismissed');
  assert.ok(byId[q3.seed_id].missing_fields.includes('无此经历'));
  assert.equal(byId[q4.seed_id].status, 'queued');
  // answered 原话原样落盘
  const answerFile = join(t, 'knowledge', 'drafts', `answer-${q1.seed_id}.md`);
  assert.ok(existsSync(answerFile));
  assert.ok(readFileSync(answerFile, 'utf8').includes('我的原话答案，一字不改。'));
});

test('answered 缺 raw_answer → exit 2', () => {
  const t = preparedRoot();
  const p = runCli(['dig', 'prepare', '--root', t, '--json']);
  const q1 = JSON.parse(p.out).questions[0];
  const f = tmpJson({ results: [{ seed_id: q1.seed_id, status: 'answered' }] });
  const r = runCli(['dig', 'ingest', '--file', f, '--root', t]);
  assert.equal(r.code, 2);
});

test('已 draft_ready/dismissed 的种子下一轮不再出现', () => {
  const t = preparedRoot();
  const p1 = JSON.parse(runCli(['dig', 'prepare', '--root', t, '--json']).out).questions;
  const f = tmpJson({
    results: p1.map((q, i) => ({ seed_id: q.seed_id, status: i === 0 ? 'answered' : 'not_done', raw_answer: i === 0 ? '答' : undefined })),
  });
  runCli(['dig', 'ingest', '--file', f, '--root', t]);
  const p2 = JSON.parse(runCli(['dig', 'prepare', '--root', t, '--json']).out).questions;
  const prevIds = new Set(p1.map((q) => q.seed_id));
  for (const q of p2) assert.ok(!prevIds.has(q.seed_id), `已处理的种子不应再出现：${q.intent_key}`);
});

test('引用不存在的 seed_id → exit 2', () => {
  const t = preparedRoot();
  const f = tmpJson({ results: [{ seed_id: 'deadbeefdead', status: 'skipped' }] });
  const r = runCli(['dig', 'ingest', '--file', f, '--root', t]);
  assert.equal(r.code, 2);
});
