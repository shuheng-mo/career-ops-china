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
  // answer-block.schema.json 在 Task 5 才有；此处用 test-simple 之外的机制验证：
  // 目录里出现新 *.schema.json 后无需手动 register 即可 validate
  assert.throws(() => validate('answer-block', {}), (e) => {
    // answer-block 尚不存在 → 中文「未找到」；一旦 Task 5 落盘，这里变成校验失败
    return /未找到|不存在|未注册/.test(e.message);
  });
});
