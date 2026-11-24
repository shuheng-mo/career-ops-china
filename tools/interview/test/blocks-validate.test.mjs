import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');
const FIXTURE = join(HERE, 'fixtures', 'block-demo.md');

function runCli(args) {
  try {
    const out = execFileSync('node', [CLI, ...args], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function tmpWith(content) {
  const dir = mkdtempSync(join(tmpdir(), 'ib-validate-'));
  const f = join(dir, 'block.md');
  writeFileSync(f, content);
  return f;
}

const GOOD_FIXTURE = `---
schema_version: 1
block_id: demo.query-permission
revision: 1
kind: qa
project: demo
status: active
tracks: [ai-app]
rounds: [technical]
questions:
  - 你如何限制查询权限？
  - 怎样防止越权读取数据？
anchors: [身份识别, 权限过滤, 执行校验]
fact_refs: ["tech:demo.permission"]
claim_kind: experience
related: [demo.audit]
criticality: high
pinned: false
source_refs:
  - {artifact_id: import-demo, locator: 'lines:12-24'}
rubric:
  required:
    - {id: p1, text: 明确说明权限检查时机, weight: 2}
    - {id: p2, text: 说明实际能力的边界, weight: 1}
  forbidden:
    - {id: f1, text: 声称已经实现未经验证的权限功能, severity: major}
---
## 30 秒版
示例答案。
`;

test('fixture 块 validate 通过（exit 0）', () => {
  const r = runCli(['validate', '--file', FIXTURE]);
  assert.equal(r.code, 0, `期望 exit 0，实际 ${r.code}：${r.out}`);
});

test('未知字段 → exit 2 且错误含字段名', () => {
  const f = tmpWith(GOOD_FIXTURE.replace('pinned: false', 'pinned: false\nunknown_field: x'));
  const r = runCli(['validate', '--file', f]);
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown_field/);
});

test('非法 block_id → exit 2', () => {
  const f = tmpWith(GOOD_FIXTURE.replace('block_id: demo.query-permission', "block_id: 'Bad ID'"));
  const r = runCli(['validate', '--file', f]);
  assert.equal(r.code, 2);
});

test('rubric 重复 id → exit 2', () => {
  const f = tmpWith(GOOD_FIXTURE.replace(
    '    - {id: p2, text: 说明实际能力的边界, weight: 1}',
    '    - {id: p1, text: 重复的 id, weight: 1}'
  ));
  const r = runCli(['validate', '--file', f]);
  assert.equal(r.code, 2);
  assert.match(r.out, /rubric|p1/);
});

test('claim_kind: experience 且 fact_refs 为空 → exit 2', () => {
  const f = tmpWith(GOOD_FIXTURE.replace('fact_refs: ["tech:demo.permission"]', 'fact_refs: []'));
  const r = runCli(['validate', '--file', f]);
  assert.equal(r.code, 2);
});

test('不存在的文件 → exit 4', () => {
  const r = runCli(['validate', '--file', '/tmp/does-not-exist-block.md']);
  assert.equal(r.code, 4);
});

test('未知子命令 → exit 3', () => {
  const r = runCli(['no-such-command']);
  assert.equal(r.code, 3);
});

test('--json 输出可解析', () => {
  const r = runCli(['validate', '--file', FIXTURE, '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out).ok, true);
});
