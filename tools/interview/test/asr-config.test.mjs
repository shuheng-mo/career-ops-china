// buildAsrProviderFactory：profile.yml interview.asr 段 → provider 工厂
// 覆盖：默认 mock / aliyun 完整与缺件 / api_key_env 自定义 / sherpa / 未知 provider
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAsrProviderFactory } from '../server/asr-config.mjs';

test('[AC1] 未配置 / none / replay → mock 工厂（演练可用，不花钱）', () => {
  for (const cfg of [undefined, {}, { provider: 'none' }, { provider: 'replay' }]) {
    const f = buildAsrProviderFactory(cfg, {});
    assert.equal(f.provider, 'mock');
    assert.equal(f.createProvider().id, 'mock');
  }
});

test('[AC1b] provider none 但 key 环境变量已存在 → detail 明确提示还差 provider/endpoint', () => {
  const f = buildAsrProviderFactory({ provider: 'none' }, { CAREER_OPS_ASR_API_KEY: 'sk-x' });
  assert.equal(f.provider, 'mock');
  assert.match(f.detail, /CAREER_OPS_ASR_API_KEY/);
  assert.match(f.detail, /provider 仍为 none/);
});

test('[AC2] aliyun-fun-asr 完整配置 → AliyunFunAsrProvider 实例', () => {
  const f = buildAsrProviderFactory(
    { provider: 'aliyun-fun-asr', endpoint: 'wss://stub', model: 'fun-asr-realtime', vocabulary_id: 'vid' },
    { CAREER_OPS_ASR_API_KEY: 'sk-test' },
  );
  assert.equal(f.provider, 'aliyun-fun-asr');
  const p = f.createProvider();
  assert.equal(p.id, 'aliyun-fun-asr');
  assert.equal(p.endpoint, 'wss://stub');
  assert.equal(p.apiKey, 'sk-test');
  assert.equal(p.vocabularyId, 'vid');
});

test('[AC3] aliyun 缺 key → 中文报错含环境变量名与指引', () => {
  assert.throws(
    () => buildAsrProviderFactory({ provider: 'aliyun-fun-asr', endpoint: 'wss://stub' }, {}),
    (e) => e.message.includes('CAREER_OPS_ASR_API_KEY') && e.message.includes('mock'),
  );
});

test('[AC4] aliyun 缺 endpoint → 中文报错', () => {
  assert.throws(
    () => buildAsrProviderFactory({ provider: 'aliyun-fun-asr' }, { CAREER_OPS_ASR_API_KEY: 'sk' }),
    (e) => e.message.includes('endpoint'),
  );
});

test('[AC5] api_key_env 自定义环境变量名生效', () => {
  const f = buildAsrProviderFactory(
    { provider: 'aliyun-fun-asr', endpoint: 'wss://stub', api_key_env: 'MY_KEY' },
    { MY_KEY: 'sk-custom' },
  );
  assert.equal(f.createProvider().apiKey, 'sk-custom');
});

test('[AC6] sherpa-local → 工厂可构造（probe/接线状态由运行时报告，不阻塞启动）', () => {
  const f = buildAsrProviderFactory({ provider: 'sherpa-local' }, {});
  assert.equal(f.provider, 'sherpa-local');
  assert.equal(f.createProvider().id, 'sherpa-local');
});

test('[AC7] 未知 provider → 中文报错列出可选项', () => {
  assert.throws(
    () => buildAsrProviderFactory({ provider: 'gcp' }, {}),
    (e) => e.message.includes('未知') && e.message.includes('aliyun-fun-asr'),
  );
});
