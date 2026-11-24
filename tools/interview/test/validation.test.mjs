import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, assertValid, registerSchema, ValidationError } from '../core/validation.mjs';

const simple = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { a: { type: 'number' } },
  required: ['a'],
  additionalProperties: false,
};

test('registerSchema + validate 通过与失败', () => {
  registerSchema('test-simple', simple);
  assert.deepEqual(validate('test-simple', { a: 1 }), { ok: true, errors: [] });
  const r = validate('test-simple', { a: 'x' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 1);
  assert.match(r.errors[0], /a/);
});

test('未注册的 schema 报中文错', () => {
  assert.throws(() => validate('no-such-schema-xyz', {}), /未找到|不存在|未注册/);
});

test('assertValid 抛 ValidationError', () => {
  assert.throws(() => assertValid('test-simple', {}), (e) => e instanceof ValidationError);
});

test('additionalProperties: false 拒绝未知字段', () => {
  const r = validate('test-simple', { a: 1, extra: true });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /extra/);
});

test('schemas 目录中的 schema 文件自动按文件名注册', () => {
  // answer-block.schema.json 已随 Task 5 落盘：无需手动 register，
  // validate('answer-block', …) 即可用文件里的 schema 校验
  const r = validate('answer-block', {});
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  // 真正不存在的 schema 名仍然报中文「未找到」
  assert.throws(() => validate('definitely-missing-schema', {}), /未找到|不存在|未注册/);
});
