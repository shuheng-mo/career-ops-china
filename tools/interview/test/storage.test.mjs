import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  resolveRoot, safeJoin, atomicWriteJson, atomicWriteText,
  appendJsonl, readJsonlSafe, withLock, PathEscapeError,
} from '../core/storage.mjs';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'interview-storage-'));
}

test('resolveRoot 默认指向仓库 interview-prep 并给出完整 paths', () => {
  const { root, paths } = resolveRoot();
  assert.ok(root.endsWith('interview-prep'));
  assert.ok(paths.blocksDir.includes('knowledge/blocks'));
  assert.ok(paths.bootstrapFile.endsWith('knowledge/bootstrap.json'));
  assert.ok(paths.signalsFile.endsWith('knowledge/signals.jsonl'));
  assert.ok(paths.versionsDir.includes('knowledge/versions'));
});

test('resolveRoot 尊重 --root 注入', () => {
  const t = tmpRoot();
  const { root } = resolveRoot(t);
  assert.equal(resolve(root), resolve(t));
});

test('safeJoin 拒绝 .. 穿越、绝对路径与越界 symlink', () => {
  const t = tmpRoot();
  assert.throws(() => safeJoin(t, '../outside'), PathEscapeError);
  assert.throws(() => safeJoin(t, '/etc/passwd'), PathEscapeError);
  assert.throws(() => safeJoin(t, 'a', '..', '..', 'b'), PathEscapeError);
  const outsideFile = join(tmpdir(), `interview-outside-${Date.now()}.txt`);
  writeFileSync(outsideFile, 'x');
  const link = join(t, 'link');
  symlinkSync(outsideFile, link);
  assert.throws(() => safeJoin(t, 'link'), PathEscapeError);
  rmSync(link);
  rmSync(outsideFile);
});

test('safeJoin 正常路径放行且返回 root 内绝对路径', () => {
  const t = tmpRoot();
  const p = safeJoin(t, 'knowledge', 'blocks', 'demo.x.md');
  assert.ok(p.startsWith(resolve(t)));
});

test('atomicWriteJson 原子落盘且可读回', () => {
  const t = tmpRoot();
  const f = join(t, 'state.json');
  atomicWriteJson(f, { a: 1, 中文: '值' });
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { a: 1, 中文: '值' });
  assert.equal(existsSync(`${f}.tmp`), false);
  atomicWriteText(f, 'hello');
  assert.equal(readFileSync(f, 'utf8'), 'hello');
});

test('appendJsonl 追加两行 JSONL', () => {
  const t = tmpRoot();
  const f = join(t, 'events.jsonl');
  appendJsonl(f, { seq: 1 });
  appendJsonl(f, { seq: 2 });
  const rows = readFileSync(f, 'utf8').trim().split('\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows[1]), { seq: 2 });
});

test('readJsonlSafe 丢弃尾部不完整行并标记 recovered', () => {
  const t = tmpRoot();
  const f = join(t, 'events.jsonl');
  writeFileSync(f, '{"seq":1}\n{"seq":2}\n{"seq":3}\n{"trunc');
  const { rows, recovered } = readJsonlSafe(f);
  assert.equal(rows.length, 3);
  assert.equal(recovered, 1);
});

test('readJsonlSafe 空文件返回空数组', () => {
  const t = tmpRoot();
  const { rows, recovered } = readJsonlSafe(join(t, 'none.jsonl'));
  assert.deepEqual(rows, []);
  assert.equal(recovered, 0);
});

test('withLock 互斥：持锁期间再入抛中文错，释放后可再入', () => {
  const t = tmpRoot();
  const f = join(t, 'signals.jsonl');
  withLock(f, () => {
    assert.throws(() => withLock(f, () => {}), /另一个进程正在写/);
  });
  withLock(f, () => {});
  assert.equal(existsSync(`${f}.lock`), false);
});
