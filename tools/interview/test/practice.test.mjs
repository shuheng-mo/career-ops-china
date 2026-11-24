import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function tmpJson(obj) {
  const f = join(mkdtempSync(join(tmpdir(), 'ib-practice-f-')), 'x.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

function approveOne(root, { track = ['ai-app'], blockId = 'demo.intro-self', status } = {}) {
  const t = root;
  runCli(['init', '--root', t]);
  runCli(['bootstrap', '--from', 'cv', '--cv', CV_FIXTURE, '--root', t]);
  const p = JSON.parse(runCli(['dig', 'prepare', '--root', t, '--json']).out);
  const q1 = p.questions[0];
  const digF = join(mkdtempSync(join(tmpdir(), 'ib-practice-d-')), 'r.json');
  writeFileSync(digF, JSON.stringify({ results: [{ seed_id: q1.seed_id, status: 'answered', raw_answer: '原话。' }] }));
  runCli(['dig', 'ingest', '--file', digF, '--root', t]);
  const fm = ['---', 'schema_version: 1', `block_id: ${blockId}`, 'revision: 1', 'kind: intro', 'status: active', `tracks: [${track.join(', ')}]`, 'rounds: [hr]', `questions:\n  - ${q1.question}`, 'anchors: [虚构锚点一, 虚构锚点二]', 'fact_refs: []', 'claim_kind: knowledge', 'criticality: normal', 'pinned: false', 'source_refs: []', '---', ''].join('\n');
  const body = '## 30 秒版\n虚构答案。\n## 详细版\n虚构。\n## 技术边界\n虚构。';
  writeFileSync(join(t, 'knowledge', 'blocks', `${blockId}.md`), fm + body);
  return { t, q1, body };
}

test('空库 practice → exit 0 + 中文引导', () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-practice-'));
  runCli(['init', '--root', t]);
  const r = runCli(['practice', '--root', t]);
  assert.equal(r.code, 0);
  assert.match(r.out, /知识库为空|bootstrap/);
});

test('approve 后 practice 输出问题、锚点与 30 秒版', () => {
  const { t } = approveOne(mkdtempSync(join(tmpdir(), 'ib-practice-')));
  const r = runCli(['practice', '--root', t]);
  assert.equal(r.code, 0);
  assert.match(r.out, /30 秒版/);
  assert.match(r.out, /虚构锚点一/);
  assert.match(r.out, /自我介绍|question/);
});

test('--track 过滤：track 不匹配的块不出现', () => {
  const { t } = approveOne(mkdtempSync(join(tmpdir(), 'ib-practice-')), { track: ['auto-data'] });
  const r = runCli(['practice', '--root', t, '--track', 'ai-app']);
  assert.equal(r.code, 0);
  assert.match(r.out, /0|没有|无/);
});

test('draft 状态块不出现在题单', () => {
  const { t } = approveOne(mkdtempSync(join(tmpdir(), 'ib-practice-')));
  const f = join(t, 'knowledge', 'blocks', 'demo.intro-self.md');
  writeFileSync(f, readFileSync(f, 'utf8').replace('status: active', 'status: draft'));
  const r = runCli(['practice', '--root', t]);
  assert.match(r.out, /知识库为空|没有可练习/);
});
