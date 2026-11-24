import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const CLI = join(REPO, 'tools', 'interview', 'cli.mjs');

function runCli(args, { cwd } = {}) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8', cwd }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function runNpm(args) {
  try {
    return { code: 0, out: execFileSync('npm', ['run', '--silent', 'interview:kb', '--', ...args], { encoding: 'utf8', cwd: REPO }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function preparedRoot() {
  const t = mkdtempSync(join(tmpdir(), 'ib-sec-'));
  runCli(['init', '--root', t]);
  return t;
}

test('[C1] npm run interview:kb 文档入口可用', () => {
  const t = mkdtempSync(join(tmpdir(), 'ib-sec-npm-'));
  const r = runNpm(['init', '--root', t, '--json']);
  assert.equal(r.code, 0, `npm 入口失败：${r.out.slice(0, 300)}`);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
});

test('[C2] --session 路径穿越 → 拒绝（exit 2）', () => {
  const t = preparedRoot();
  // 先造一个 root 外的合法结构，证明穿越会读到它
  const outside = mkdtempSync(join(tmpdir(), 'ib-sec-outside-'));
  mkdirSync(join(outside, 'reviews'), { recursive: true });
  writeFileSync(join(outside, 'reviews', 'review.json'), '{"hacked":true}');
  // 直接以相对路径穿越
  let r = runCli(['review', 'show', '--session', '../../escaped-session', '--root', t, '--json']);
  assert.equal(r.code, 2, `期望拒绝，实际 code=${r.code} out=${r.out.slice(0, 200)}`);
  // 绝对路径
  r = runCli(['review', 'show', '--session', join(outside), '--root', t, '--json']);
  assert.equal(r.code, 2);
  // 非 uuid 格式
  r = runCli(['review', 'show', '--session', 'not-a-uuid', '--root', t, '--json']);
  assert.equal(r.code, 2);
});

test('[C2] segment/align/patch 的 id 同样拒绝穿越', () => {
  const t = preparedRoot();
  const f = join(mkdtempSync(join(tmpdir(), 'ib-sec-2-')), 'x.json');
  writeFileSync(f, JSON.stringify({ results: [{ question_id: 'q001', utterance_refs: ['u001'], kind: 'question' }] }));
  let r = runCli(['segment', 'apply', '--session', '../../../evil', '--file', f, '--root', t]);
  assert.equal(r.code, 2);
  r = runCli(['patch', 'apply', '../../../../evil', '--root', t]);
  assert.equal(r.code, 2);
});
