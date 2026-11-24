import Ajv2020 from 'ajv/dist/2020.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const registered = new Set();

export function registerSchema(name, schemaObject) {
  const key = ajv.addSchema(schemaObject, name);
  registered.add(name);
  return key;
}

function ensureSchema(name) {
  if (registered.has(name)) return;
  const file = join(SCHEMAS_DIR, `${name}.schema.json`);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new ValidationError(`未找到名为「${name}」的 schema（${name}.schema.json 不存在）`);
  }
  registerSchema(name, JSON.parse(raw));
}

function formatErrors(errors) {
  return (errors || []).map((e) => {
    const at = e.instancePath || '(root)';
    const extra = e.params && e.params.additionalProperty
      ? `（字段: ${e.params.additionalProperty}）`
      : '';
    return `${at}: ${e.message}${extra}`;
  });
}

export function validate(name, data) {
  ensureSchema(name);
  const ok = ajv.validate(name, data);
  return ok ? { ok: true, errors: [] } : { ok: false, errors: formatErrors(ajv.errors) };
}

export function assertValid(name, data) {
  const r = validate(name, data);
  if (!r.ok) {
    throw new ValidationError(`校验失败（schema: ${name}）：\n- ${r.errors.join('\n- ')}`);
  }
  return true;
}
