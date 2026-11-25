// 检索服务：词法 ↔ hybrid(embedding) 的配置驱动切换（P3.3 遗留接线，真实面试 e2e 修复 3）。
// profile.yml interview.embedding 段：provider: openai-compatible + base_url + model + api_key_env。
// 降级矩阵：未配置 → 词法；配了缺 key → 词法（doctor/启动行提示）；hybrid 运行失败 → 词法（记 lastError，不静默）。
import { readBlocks } from '../core/blocks.mjs';
import { buildIndex, search } from '../retrieval/bm25.mjs';
import { createEmbeddingProvider, buildHybridIndex, hybridSearch } from '../providers/embedding.mjs';

export const DEFAULT_EMBED_KEY_ENV = 'CAREER_OPS_ASR_API_KEY'; // 百炼 DASHSCOPE key 与 ASR 同一个

let current = null;

export function configureRetrieval(embeddingCfg, env = process.env) {
  if (embeddingCfg && embeddingCfg.provider === 'openai-compatible' && embeddingCfg.base_url && embeddingCfg.model) {
    const keyEnv = embeddingCfg.api_key_env || DEFAULT_EMBED_KEY_ENV;
    const apiKey = env[keyEnv];
    if (!apiKey) {
      current = { mode: 'lexical', detail: `词法（embedding 已配置但缺环境变量 ${keyEnv}）` };
      return current;
    }
    try {
      const provider = createEmbeddingProvider({ ...embeddingCfg, apiKey });
      current = { mode: 'hybrid', provider, detail: `hybrid（${embeddingCfg.model}，key 来自 ${keyEnv}）`, lastError: null };
      return current;
    } catch (e) {
      current = { mode: 'lexical', detail: `词法（embedding 构造失败：${e.message}）` };
      return current;
    }
  }
  current = { mode: 'lexical', detail: '词法（未配置 embedding）' };
  return current;
}

export function getRetriever() {
  if (!current) configureRetrieval(null);
  return current;
}

// 统一检索入口：返回 { results, threshold }（threshold = autoThresholdFor(lexical)，供 decide 用）
export async function runSearch(root, query, { topK = 5 } = {}) {
  const blocks = readBlocks(root).map((b) => ({ block_id: b.block_id, frontMatter: b.frontMatter, body: b.body }));
  const lexicalIndex = buildIndex(blocks);
  const { autoThresholdFor } = await import('../retrieval/rank.mjs');
  const threshold = autoThresholdFor(lexicalIndex);
  const r = getRetriever();
  if (r.mode === 'hybrid') {
    try {
      const hybridIndex = await buildHybridIndex(blocks, { provider: r.provider });
      const results = await hybridSearch(hybridIndex, query, { provider: r.provider, topK });
      return { results, threshold };
    } catch (e) {
      r.lastError = e.message; // 降级不静默：诊断时可查
      return { results: search(lexicalIndex, query, { topK }), threshold, degraded: true };
    }
  }
  return { results: search(lexicalIndex, query, { topK }), threshold };
}
