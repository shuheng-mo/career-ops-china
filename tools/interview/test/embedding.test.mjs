import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createEmbeddingProvider, buildHybridIndex, hybridSearch } from '../providers/embedding.mjs';

// 本地 stub：OpenAI-compatible /embeddings，请求计数（验证缓存）。
// 向量按「块问题原文」发 key——块 embed 时拿真实语义向量而非 default。
const VECTORS = {
  '你如何限制查询权限？': [1, 0, 0],
  '多模型路由怎么设计的？': [0, 1, 0],
  '防止越权读取数据': [0.95, 0.05, 0], // 查询：词法对两块都零重叠，语义最近 perm
  __default__: [0, 0, 1],
};

function startStub() {
  let hits = 0;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      hits += 1;
      const { input } = JSON.parse(data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: input.map((text) => ({ embedding: VECTORS[text] || VECTORS.__default__ })),
      }));
    });
  });
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server, close,
      url: `http://127.0.0.1:${server.address().port}`,
      hitsRef: () => hits,
    }));
  });
}

test('[S3.6] provider：embed 调用 stub 返回向量', async () => {
  const { close, url, hitsRef } = await startStub();
  try {
    const provider = createEmbeddingProvider({ base_url: url, model: 'text-embedding-v4', apiKey: 'sk-test' });
    const vecs = await provider.embed(['权限问题']);
    assert.equal(vecs.length, 1);
    assert.deepEqual(vecs[0], VECTORS.__default__);
    assert.equal(hitsRef(), 1);
  } finally {
    close();
  }
});

test('[S3.6] 缓存：同文本二次 embed 不再发请求', async () => {
  const { close, url, hitsRef } = await startStub();
  try {
    const provider = createEmbeddingProvider({ base_url: url, model: 'text-embedding-v4', apiKey: 'sk-test' });
    await provider.embed(['你如何限制查询权限？', '多模型路由怎么设计的？']);
    assert.equal(hitsRef(), 1);
    await provider.embed(['你如何限制查询权限？']);
    assert.equal(hitsRef(), 1, '缓存命中不发请求');
    await provider.embed(['防止越权读取数据']);
    assert.equal(hitsRef(), 2);
  } finally {
    close();
  }
});

test('[S3.6] provider 失败 → 抛错，调用方降级 lexical', async () => {
  const provider = createEmbeddingProvider({ base_url: 'http://127.0.0.1:1', model: 'x', apiKey: 'k' });
  await assert.rejects(() => provider.embed(['权限问题']));
});

test('[S3.6] hybrid：词法零重叠的语义查询经 RRF 排到首位', async () => {
  const { close, url } = await startStub();
  try {
    const provider = createEmbeddingProvider({ base_url: url, model: 'text-embedding-v4', apiKey: 'sk-test' });
    const blocks = [
      { block_id: 'demo.perm', frontMatter: { questions: ['你如何限制查询权限？'], anchors: ['权限过滤'] }, body: '## 30 秒版\n按角色过滤表和列。' },
      { block_id: 'demo.routing', frontMatter: { questions: ['多模型路由怎么设计的？'], anchors: ['成本'] }, body: '## 30 秒版\n按意图分流。' },
    ];
    const hybrid = await buildHybridIndex(blocks, { provider });
    // 词法通道：「怎么限制查询权限」强命中 perm
    const r1 = await hybridSearch(hybrid, '怎么限制查询权限', { provider });
    assert.equal(r1[0].blockId, 'demo.perm');
    // 语义通道：查询对两块词法都零重叠，向量把 perm 排前
    const r2 = await hybridSearch(hybrid, '防止越权读取数据', { provider });
    assert.equal(r2[0].blockId, 'demo.perm', `RRF 融合应让语义命中靠前：${JSON.stringify(r2)}`);
    // 默认 lexical（无 provider）不受影响
    const lexicalOnly = await hybridSearch(hybrid, '怎么限制查询权限', {});
    assert.equal(lexicalOnly[0].blockId, 'demo.perm');
  } finally {
    close();
  }
});
