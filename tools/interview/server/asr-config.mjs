// profile.yml interview.asr 段 → provider 工厂（studio 启动与 doctor 共用）。
// Key 只从环境变量读（api_key_env，默认 CAREER_OPS_ASR_API_KEY），不进配置文件/日志/浏览器。
import { AliyunFunAsrProvider } from '../providers/asr/aliyun-fun-asr.mjs';
import { SherpaLocalProvider } from '../providers/asr/sherpa-local.mjs';
import { createMockAsrProvider } from '../providers/asr/mock.mjs';

export const DEFAULT_ASR_KEY_ENV = 'CAREER_OPS_ASR_API_KEY';

export function buildAsrProviderFactory(asrCfg = {}, env = process.env) {
  const provider = asrCfg.provider || 'none';
  if (provider === 'none' || provider === 'replay') {
    return {
      provider: 'mock',
      createProvider: () => createMockAsrProvider(),
      detail: 'mock（未配置云端 ASR，语音模式仅演练，不产生费用）',
    };
  }
  if (provider === 'aliyun-fun-asr') {
    const endpoint = (asrCfg.endpoint || '').trim();
    const keyEnv = asrCfg.api_key_env || DEFAULT_ASR_KEY_ENV;
    const apiKey = env[keyEnv];
    const missing = [];
    if (!endpoint) missing.push('interview.asr.endpoint（百炼 fun-asr-realtime 的 WS 地址）');
    if (!apiKey) missing.push(`环境变量 ${keyEnv}（百炼 API Key，只放环境变量不写进配置文件）`);
    if (missing.length) {
      throw new Error(`aliyun-fun-asr 配置不完整，缺：${missing.join('；')}。修复前可把 interview.asr.provider 改回 none 用 mock 演练。`);
    }
    const model = asrCfg.model || 'fun-asr-realtime';
    return {
      provider: 'aliyun-fun-asr',
      createProvider: () => new AliyunFunAsrProvider({
        endpoint,
        apiKey,
        model,
        vocabularyId: asrCfg.vocabulary_id || '',
      }),
      detail: `aliyun-fun-asr（model: ${model}，key 来自 ${keyEnv}；成本闸门 ${asrCfg.max_session_minutes ?? 90} 分钟/场、预算 ${asrCfg.max_estimated_cny ?? 3} 元）`,
    };
  }
  if (provider === 'sherpa-local') {
    return {
      provider: 'sherpa-local',
      createProvider: () => new SherpaLocalProvider({}),
      detail: 'sherpa-local（本地识别；需 npm install sherpa-onnx-node + 模型 manifest，识别引擎在用户验收阶段接线）',
    };
  }
  throw new Error(`未知 interview.asr.provider：${provider}（可选 none | aliyun-fun-asr | sherpa-local | replay）`);
}
