// BYOK embedding provider（spec §3.1/§3.3，默认关闭）：
// OpenAI-compatible /embeddings；内存缓存键 model|文本；
// 传输用 node:http 原生请求（不用 undici fetch——其连接池 keep-alive 会挂住测试进程）；
// hybrid = 词法 BM25 与向量余弦 RRF 融合（k=60）；provider 失败由调用方降级 lexical。
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { buildIndex, search } from '../retrieval/bm25.mjs';

// 传输选择：https base_url（百炼/OpenAI 等）必须走 node:https 与 443 默认端口
export function requestOptionsFor(url) {
  const isHttps = url.protocol === 'https:';
  return {
    mod: isHttps ? 'https' : 'http',
    port: url.port ? Number(url.port) : (isHttps ? 443 : 80),
  };
}

export function createEmbeddingProvider({ base_url: baseUrl, model, apiKey, timeoutMs = 15000 }) {
  if (!baseUrl || !model) throw new Error('embedding provider 需要 base_url 与 model');
  const cache = new Map();
  const url = new URL(baseUrl);

  function postEmbeddings(inputs) {
    return new Promise((resolve, reject) => {
      const opts = requestOptionsFor(url);
      const transport = opts.mod === 'https' ? https : http;
      const payload = JSON.stringify({ model, input: inputs });
      const req = transport.request(
        {
          hostname: url.hostname,
          port: opts.port,
          path: `${url.pathname.replace(/\/$/, '')}/embeddings`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey || ''}`,
            'Content-Length': Buffer.byteLength(payload),
            Connection: 'close',
          },
          timeout: timeoutMs,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`embedding 请求失败：HTTP ${res.statusCode}`));
              return;
            }
            try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`embedding 响应非 JSON：${e.message}`)); }
          });
        },
      );
      req.on('timeout', () => { req.destroy(new Error(`embedding 请求超时（${timeoutMs}ms）`)); });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  return {
    id: 'openai-compatible',
    model,
    cacheSize: () => cache.size,
    async embed(texts) {
      const out = new Array(texts.length);
      const pending = [];
      for (let i = 0; i < texts.length; i++) {
        const key = `${model}|${texts[i]}`;
        if (cache.has(key)) out[i] = cache.get(key);
        else pending.push({ i, text: texts[i], key });
      }
      if (pending.length) {
        const json = await postEmbeddings(pending.map((p) => p.text));
        const dims = new Set((json.data || []).map((d) => d.embedding.length));
        if (dims.size > 1) throw new Error('embedding 维度不一致，拒绝混用');
        json.data.forEach((d, idx) => {
          const { i, key } = pending[idx];
          cache.set(key, d.embedding);
          out[i] = d.embedding;
        });
      }
      return out;
    },
  };
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// 混合索引：词法（复用 P1 BM25）+ 向量（每块一个问题向量）
export async function buildHybridIndex(blocks, { provider } = {}) {
  const lexical = buildIndex(blocks);
  let vectors = null;
  if (provider) {
    const texts = blocks.map((b) => (b.frontMatter.questions || []).join('\n') || b.block_id);
    const vecs = await provider.embed(texts);
    vectors = new Map(blocks.map((b, i) => [b.block_id, vecs[i]]));
  }
  return { lexical, vectors, blocks };
}

const RRF_K = 60;

export async function hybridSearch(index, query, { provider, topK = 5 } = {}) {
  const lexicalResults = search(index.lexical, query, { topK });
  if (!provider || !index.vectors) return lexicalResults; // 默认 lexical
  const [qvec] = await provider.embed([query]);
  const vecRanked = [...index.vectors.entries()]
    .map(([blockId, vec]) => ({ blockId, score: cosine(qvec, vec) }))
    .sort((a, b) => b.score - a.score);
  const scores = new Map();
  lexicalResults.forEach((r, rank) => {
    scores.set(r.blockId, (scores.get(r.blockId) || 0) + 1 / (RRF_K + rank + 1));
  });
  vecRanked.forEach((r, rank) => {
    scores.set(r.blockId, (scores.get(r.blockId) || 0) + 1 / (RRF_K + rank + 1));
  });
  return [...scores.entries()]
    .map(([blockId, score]) => ({ blockId, score, matchedQuestion: lexicalResults.find((r) => r.blockId === blockId)?.matchedQuestion ?? null }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
