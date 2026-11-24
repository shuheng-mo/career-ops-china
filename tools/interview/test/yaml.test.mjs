import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadYamlSafe, splitFrontMatter, YamlSafeError } from '../core/yaml.mjs';

test('loadYamlSafe 拒绝重复 key 且报中文', () => {
  assert.throws(
    () => loadYamlSafe('a: 1\na: 2'),
    (e) => e instanceof YamlSafeError && /重复/.test(e.message)
  );
});

test('loadYamlSafe 拒绝未知 tag', () => {
  assert.throws(() => loadYamlSafe('a: !!python/object x'), YamlSafeError);
});

test('loadYamlSafe 解析正常对象', () => {
  assert.deepEqual(loadYamlSafe('a: 1\nb:\n  - x'), { a: 1, b: ['x'] });
});

test('splitFrontMatter 切出 front matter 与 body（body 含 --- 不受影响）', () => {
  const md = '---\nblock_id: demo.x\nrevision: 1\n---\n## 30 秒版\n正文\n\n---\n';
  const { frontMatter, body } = splitFrontMatter(md);
  assert.equal(frontMatter.block_id, 'demo.x');
  assert.equal(frontMatter.revision, 1);
  assert.match(body, /## 30 秒版/);
  assert.ok(!body.startsWith('---'));
});

test('splitFrontMatter 无围栏抛 YamlSafeError', () => {
  assert.throws(() => splitFrontMatter('# 没有 front matter'), YamlSafeError);
});
