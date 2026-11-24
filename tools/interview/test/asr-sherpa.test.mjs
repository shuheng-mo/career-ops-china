import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SherpaLocalProvider, readSherpaManifest } from '../providers/asr/sherpa-local.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('[P4.3] probe：模块缺失 → 中文降级提示（不影响其他功能）', async () => {
  // 环境内未安装 sherpa-onnx-node（仓库依赖里没有）→ probe 应明确失败
  const p = new SherpaLocalProvider({});
  const r = await p.probe();
  if (!r.ok) {
    assert.match(r.reason, /sherpa-onnx-node|manifest|模型/);
  } else {
    // 若用户环境装了模块且配了模型，也可通过
    assert.match(r.reason, /就绪/);
  }
  // provider 的 start/push 失败不影响模块加载（动态 import 不在顶层）
  await assert.rejects(() => p.start({ sessionId: 's' }), /不可用|接线/);
  await p.push().catch(() => {});
  await p.close();
});

test('[P4.3] manifest 缺字段 / 坏 path → 明确报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ib-sherpa-'));
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ path: 'x' }));
  assert.throws(() => readSherpaManifest(bad), /缺字段/);
  const trav = join(dir, 'trav.json');
  writeFileSync(trav, JSON.stringify({ path: '../evil', sha256: 'x', source: 's', license: 'l', sample_rate: 16000, language: 'zh' }));
  assert.throws(() => readSherpaManifest(trav), /穿越|非法/);
  const badRate = join(dir, 'rate.json');
  writeFileSync(badRate, JSON.stringify({ path: '/tmp', sha256: 'x', source: 's', license: 'l', sample_rate: -1, language: 'zh' }));
  assert.throws(() => readSherpaManifest(badRate), /sample_rate/);
  // 不存在的 manifest 文件
  assert.throws(() => readSherpaManifest(join(dir, "none.json")), /manifest/);
});
