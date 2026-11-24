import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');
const REPO = join(HERE, '..', '..', '..');

function runCli(args) {
  try {
    return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'ib-init-'));
}

function snapshotRepoPrep() {
  const walk = (dir, prefix = '') => {
    let out = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      try {
        if (readdirSync(p)) out = out.concat(walk(p, rel));
      } catch {
        out.push(rel);
      }
    }
    return out.sort();
  };
  try {
    return walk(join(REPO, 'interview-prep'));
  } catch {
    return [];
  }
}

test('init 两次幂等：目录与 .gitkeep 不重复创建，已有内容不覆盖', () => {
  const t = tmpRoot();
  mkdirSync(join(t, 'knowledge', 'blocks'), { recursive: true });
  writeFileSync(join(t, 'knowledge', 'blocks', 'user-block.md'), '# 用户内容\n');
  let r = runCli(['init', '--root', t]);
  assert.equal(r.code, 0, r.out);
  r = runCli(['init', '--root', t]);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(t, 'knowledge', 'blocks', 'user-block.md'), 'utf8'), '# 用户内容\n');
  assert.ok(existsSync(join(t, 'sessions')));
  assert.ok(existsSync(join(t, 'knowledge', 'signals.jsonl')) === false); // init 不创建数据文件，只建目录
});

test('init --root 不写仓库 interview-prep 任何内容', () => {
  const before = snapshotRepoPrep();
  const r = runCli(['init', '--root', tmpRoot()]);
  assert.equal(r.code, 0, r.out);
  const after = snapshotRepoPrep();
  assert.deepEqual(after, before);
});

test('doctor 健康 root → exit 0 且 JSON 含五项检查', () => {
  const t = tmpRoot();
  runCli(['init', '--root', t]);
  const r = runCli(['doctor', '--root', t, '--json']);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  for (const key of ['node', 'yaml', 'ajv', 'writable', 'config']) {
    assert.ok(key in j.checks, `缺少检查项 ${key}`);
  }
  assert.ok(j.checks.node.ok);
  assert.ok(j.checks.writable.ok);
});

test('doctor 对不存在的 root → exit 2 并提示先 init', () => {
  const missing = join(tmpdir(), `ib-init-nonexistent-${Date.now()}`);
  const r = runCli(['doctor', '--root', missing, '--json']);
  assert.equal(r.code, 2);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, false);
  assert.match(j.message, /init/);
});

test('doctor root 不可写 → exit 2 中文提示', () => {
  const t = tmpRoot();
  runCli(['init', '--root', t]);
  chmodSync(t, 0o500);
  try {
    const r = runCli(['doctor', '--root', t, '--json']);
    assert.equal(r.code, 2);
    const j = JSON.parse(r.out);
    assert.match(j.message, /不可写|权限/);
  } finally {
    chmodSync(t, 0o755);
  }
});

test('config 无 interview 段不算失败，报 default (disabled)', () => {
  const t = tmpRoot();
  runCli(['init', '--root', t]);
  const r = runCli(['doctor', '--root', t, '--json']);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  assert.match(j.checks.config.detail, /default \(disabled\)|默认/);
});
