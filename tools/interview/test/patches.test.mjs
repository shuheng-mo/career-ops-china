import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBlock, readBlockById, readManifest } from '../core/blocks.mjs';
import { listPatches } from '../core/patches.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');

function runCli(args) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function tmpJson(obj) {
  const f = join(mkdtempSync(join(tmpdir(), 'ib-patch-f-')), 'patch.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}

function rootWithBlock() {
  const t = mkdtempSync(join(tmpdir(), 'ib-patch-'));
  runCli(['init', '--root', t]);
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.patched', revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['原始问题一？'], anchors: ['锚一'],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '## 30 秒版\nv1 内容。');
  return t;
}

const ALIAS_PATCH = () => ({
  type: 'alias_add',
  target_id: 'demo.patched',
  base_revision: 1,
  before_hash: null,
  proposed_diff: { questions_add: ['原始问题一的同义问法？'] },
  reason: '复盘发现同义问未被命中',
  source_refs: [{ artifact_id: 'session:test', locator: 'review' }],
});

test('alias_add：propose → approve → apply 追加问题、revision+1、manifest 更新', () => {
  const t = rootWithBlock();
  const p = ALIAS_PATCH();
  p.before_hash = readManifest(t).blocks['demo.patched'].at(-1).hash;
  let r = runCli(['patch', 'propose', '--file', tmpJson(p), '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const { patch_id } = JSON.parse(r.out);
  r = runCli(['patch', 'approve', patch_id, '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  r = runCli(['patch', 'apply', patch_id, '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const block = readBlockById(t, 'demo.patched');
  assert.equal(block.frontMatter.revision, 2);
  assert.ok(block.frontMatter.questions.includes('原始问题一的同义问法？'));
  assert.equal(readManifest(t).blocks['demo.patched'].length, 2);
  assert.equal(listPatches(t).find((x) => x.patch_id === patch_id).status, 'applied');
  // changelog 存在
  assert.ok(existsSync(join(t, 'knowledge', 'versions', 'CHANGELOG.md')));
});

test('base_revision 不匹配 → 拒绝标 stale', () => {
  const t = rootWithBlock();
  const p = { ...ALIAS_PATCH(), base_revision: 99 };
  const r = runCli(['patch', 'propose', '--file', tmpJson(p), '--root', t, '--json']);
  assert.equal(r.code, 2);
  assert.match(r.out, /stale|过期/);
  assert.equal(listPatches(t).at(-1).status, 'stale');
});

test('重复 apply → 幂等 no-op', () => {
  const t = rootWithBlock();
  const p = { ...ALIAS_PATCH(), before_hash: readManifest(t).blocks['demo.patched'].at(-1).hash };
  runCli(['patch', 'propose', '--file', tmpJson(p), '--root', t]);
  const { patch_id } = JSON.parse(runCli(['patch', 'list', '--root', t, '--json']).out).patches[0];
  runCli(['patch', 'approve', patch_id, '--root', t]);
  runCli(['patch', 'apply', patch_id, '--root', t]);
  const r = runCli(['patch', 'apply', patch_id, '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /已应用|幂等|no-op/);
  assert.equal(readBlockById(t, 'demo.patched').frontMatter.revision, 2);
});

test('同 target+diff 重复 propose → 拒绝（去重）', () => {
  const t = rootWithBlock();
  const p = { ...ALIAS_PATCH(), before_hash: readManifest(t).blocks['demo.patched'].at(-1).hash };
  runCli(['patch', 'propose', '--file', tmpJson(p), '--root', t]);
  const r = runCli(['patch', 'propose', '--file', tmpJson(p), '--root', t]);
  assert.equal(r.code, 2);
  assert.match(r.out, /重复|已存在/);
});

test('fact_conflict apply → fact-links 冲突区记录（不动 cv/ledger）', () => {
  const t = rootWithBlock();
  const p = {
    type: 'fact_conflict',
    target_id: 'tech:demo.node-count',
    base_revision: 1,
    before_hash: null,
    proposed_diff: { claimed: '20 个节点', actual: '14 节点' },
    reason: '复盘发现口径冲突',
    source_refs: [{ artifact_id: 'session:test', locator: 'review' }],
  };
  let r = runCli(['patch', 'propose', '--file', tmpJson(p), '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const { patch_id } = JSON.parse(r.out);
  runCli(['patch', 'approve', patch_id, '--root', t]);
  r = runCli(['patch', 'apply', patch_id, '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const links = readFileSync(join(t, 'knowledge', 'fact-links.yml'), 'utf8');
  assert.match(links, /fact_conflict|tech:demo.node-count/);
  assert.ok(!existsSync(join(t, 'cv.md'))); // 不碰 cv
});

test('reject 后同提案可再 propose', () => {
  const t = rootWithBlock();
  const p = { ...ALIAS_PATCH(), before_hash: readManifest(t).blocks['demo.patched'].at(-1).hash };
  runCli(['patch', 'propose', '--file', tmpJson(p), '--root', t]);
  const { patch_id } = JSON.parse(runCli(['patch', 'list', '--root', t, '--json']).out).patches[0];
  runCli(['patch', 'reject', patch_id, '--root', t]);
  assert.equal(listPatches(t).at(-1).status, 'rejected');
  const r = runCli(['patch', 'propose', '--file', tmpJson(p), '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
});

test('block_edit：apply 替换正文并 bump revision', () => {
  const t = rootWithBlock();
  const p = {
    type: 'block_edit',
    target_id: 'demo.patched',
    base_revision: 1,
    before_hash: readManifest(t).blocks['demo.patched'].at(-1).hash,
    proposed_diff: { new_body: '## 30 秒版\nv2 更新内容。' },
    reason: '复盘改进',
    source_refs: [{ artifact_id: 'session:test', locator: 'review' }],
  };
  runCli(['patch', 'propose', '--file', tmpJson(p), '--root', t]);
  const { patch_id } = JSON.parse(runCli(['patch', 'list', '--root', t, '--json']).out).patches[0];
  runCli(['patch', 'approve', patch_id, '--root', t]);
  const r = runCli(['patch', 'apply', patch_id, '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const block = readBlockById(t, 'demo.patched');
  assert.equal(block.frontMatter.revision, 2);
  assert.match(block.body, /v2 更新内容/);
});

test('[P.R] alias_add 字段名写错（questions 而非 questions_add）→ propose 即拒', async () => {
  const { proposePatch } = await import('../core/patches.mjs');
  const t = mkdtempSync(join(tmpdir(), 'ib-pat-'));
  execFileSync('node', [CLI, 'init', '--root', t], { encoding: 'utf8' });
  assert.throws(
    () => proposePatch(t, { type: 'alias_add', target_id: 'x.y', base_revision: 1, proposed_diff: { questions: ['q？'] }, reason: '字段名错误', source_refs: [{ artifact_id: 't' }] }),
    (e) => e.message.includes('questions_add'),
  );
});
