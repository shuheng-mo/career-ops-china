import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSeeds, loadBootstrap, saveSeed } from '../core/bootstrap.mjs';
import { readBlocks, readManifest } from '../core/blocks.mjs';

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

function rootWithAnsweredIntro() {
  const t = mkdtempSync(join(tmpdir(), 'ib-drafts-'));
  runCli(['init', '--root', t]);
  runCli(['bootstrap', '--from', 'cv', '--cv', CV_FIXTURE, '--root', t]);
  const p = JSON.parse(runCli(['dig', 'prepare', '--root', t, '--json']).out);
  const q1 = p.questions[0];
  const f = join(mkdtempSync(join(tmpdir(), 'ib-drafts-dig-')), 'result.json');
  writeFileSync(f, JSON.stringify({ results: [{ seed_id: q1.seed_id, status: 'answered', raw_answer: '我是李示例，虚构候选人。' }] }));
  runCli(['dig', 'ingest', '--file', f, '--root', t]);
  return { t, q1 };
}

function tmpJson(obj) {
  const f = join(mkdtempSync(join(tmpdir(), 'ib-drafts-f-')), 'drafts.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('approve 前 readBlocks 为空；approve 后块 active 且 bootstrap ready', () => {
  const { t, q1 } = rootWithAnsweredIntro();
  assert.deepEqual(readBlocks(t), []);
  const drafts = [{
    seed_id: q1.seed_id,
    block_id: 'demo.intro-self',
    claim_kind: 'knowledge',
    markdown: '## 30 秒版\n我是李示例，虚构候选人。\n## 详细版\n（虚构）\n## 技术边界\n虚构内容，无真实经历。',
    anchors: ['虚构候选人'],
    questions: [q1.question],
    fact_refs: [],
  }];
  const r = runCli(['approve', '--file', tmpJson(drafts), '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const blocks = readBlocks(t);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].frontMatter.status, 'active');
  assert.equal(blocks[0].frontMatter.revision, 1);
  assert.equal(blocks[0].frontMatter.block_id, 'demo.intro-self');
  assert.equal(loadBootstrap(t).state, 'ready');
  const seed = listSeeds(t).find((s) => s.seed_id === q1.seed_id);
  assert.equal(seed.status, 'linked');
  assert.equal(seed.answer_block_id, 'demo.intro-self');
});

test('claim_kind experience 且 fact_refs 未确认 → exit 2（未确认事实不进 active 块）', () => {
  const { t, q1 } = rootWithAnsweredIntro();
  const drafts = [{
    seed_id: q1.seed_id,
    block_id: 'demo.intro-self',
    claim_kind: 'experience',
    markdown: '## 30 秒版\n声称做过的虚构事实。',
    questions: [q1.question],
    fact_refs: ['tech:never-confirmed'],
  }];
  const r = runCli(['approve', '--file', tmpJson(drafts), '--root', t]);
  assert.equal(r.code, 2);
  assert.match(r.out, /未确认|fact|证据/);
});

test('claim_kind experience 且事实在 tech-facts.yml → 通过', () => {
  const { t, q1 } = rootWithAnsweredIntro();
  writeFileSync(join(t, 'knowledge', 'tech-facts.yml'), 'facts:\n  - id: tech:demo.intro\n    claim: 虚构事实一\n    status: confirmed\n');
  const drafts = [{
    seed_id: q1.seed_id,
    block_id: 'demo.intro-self',
    claim_kind: 'experience',
    markdown: '## 30 秒版\n基于已确认事实的回答。',
    questions: [q1.question],
    fact_refs: ['tech:demo.intro'],
  }];
  const r = runCli(['approve', '--file', tmpJson(drafts), '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
});

test('重复 approve 同一文件 → 幂等，revision 不变', () => {
  const { t, q1 } = rootWithAnsweredIntro();
  const drafts = [{
    seed_id: q1.seed_id, block_id: 'demo.intro-self', claim_kind: 'knowledge',
    markdown: '## 30 秒版\n内容。', questions: [q1.question], fact_refs: [],
  }];
  const f = tmpJson(drafts);
  runCli(['approve', '--file', f, '--root', t]);
  const r = runCli(['approve', '--file', f, '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(r.out).skipped.map((s) => s.seed_id), [q1.seed_id]);
  assert.equal(readBlocks(t)[0].frontMatter.revision, 1);
});

test('同 block_id 新版本 → revision 2，manifest 记录两个 hash', () => {
  const { t, q1 } = rootWithAnsweredIntro();
  const base = { seed_id: q1.seed_id, block_id: 'demo.intro-self', claim_kind: 'knowledge', questions: [q1.question], fact_refs: [] };
  runCli(['approve', '--file', tmpJson([{ ...base, markdown: '## 30 秒版\nv1' }]), '--root', t]);
  // 模拟修订：种子回到 draft_ready 再批准新版本
  const seed = listSeeds(t).find((s) => s.seed_id === q1.seed_id);
  seed.status = 'draft_ready';
  saveSeed(t, seed);
  const r = runCli(['approve', '--file', tmpJson([{ ...base, markdown: '## 30 秒版\nv2 更新' }]), '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const blocks = readBlocks(t);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].frontMatter.revision, 2);
  const manifest = readManifest(t);
  assert.equal(manifest.blocks['demo.intro-self'].length, 2);
  assert.notEqual(manifest.blocks['demo.intro-self'][0].hash, manifest.blocks['demo.intro-self'][1].hash);
});

test('drafts export 输出含 seed 原话与 fact_refs（agent 任务）', () => {
  const { t, q1 } = rootWithAnsweredIntro();
  const r = runCli(['drafts', 'export', '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.out);
  assert.ok(Array.isArray(j.seeds) && j.seeds.length === 1);
  assert.equal(j.seeds[0].seed_id, q1.seed_id);
  assert.ok(j.seeds[0].raw_answer.includes('李示例'));
});
