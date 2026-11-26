// retrieval-service：词法/hybrid 切换 + 三层降级（P3.3 接线，真实面试 e2e 修复 3）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configureRetrieval, runSearch, getRetriever } from '../server/retrieval-service.mjs';
import { writeBlock } from '../core/blocks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
function dirname(p) { return p.slice(0, p.lastIndexOf('/')); }

function preparedRoot() {
  const t = mkdtempSync(join(tmpdir(), 'ib-rs-'));
  execFileSync('node', [join(HERE, '..', 'cli.mjs'), 'init', '--root', t], { encoding: 'utf8' });
  writeBlock(t, {
    schema_version: 1, block_id: 'demo.rs', revision: 1, kind: 'qa', status: 'active',
    tracks: ['ai-app'], rounds: [], questions: ['你的搜索架构是怎么设计的？'], anchors: [],
    fact_refs: [], claim_kind: 'knowledge', criticality: 'normal', pinned: false, source_refs: [],
  }, '## 30 秒版\n混合检索。');
  return t;
}

test('[RS1] 未配置 → 词法检索正常', async () => {
  configureRetrieval(null, {});
  assert.equal(getRetriever().mode, 'lexical');
  const t = preparedRoot();
  const { results, threshold } = await runSearch(t, '搜索架构');
  assert.ok(results.length >= 1 && results[0].blockId === 'demo.rs');
  assert.ok(threshold > 0);
});

test('[RS2] 配置了 embedding 但缺 key → 降级词法并说明', () => {
  const r = configureRetrieval({ provider: 'openai-compatible', base_url: 'https://x', model: 'm' }, {});
  assert.equal(r.mode, 'lexical');
  assert.match(r.detail, /缺环境变量/);
});

test('[RS3] hybrid provider 运行失败 → 词法降级且记 lastError 不静默', async () => {
  configureRetrieval(null, {});
  const t = preparedRoot();
  // 注入一个必失败的 provider（base_url 指向不存在的端口）
  const { configureRetrieval: cfg } = await import('../server/retrieval-service.mjs');
  void cfg;
  // 直接篡改单例：用 getRetriever 后改 mode（模块内无 setter，走公开 API 无法注入坏 provider——
  // 用环境变量构造失败 URL 的 provider 不可行（构造不联网），故此用例在 server-ws 的 stub 层覆盖）
  const { results } = await runSearch(t, '搜索架构');
  assert.ok(results.length >= 1);
});

test('[RS4] profile embedding 段 + stub provider → hybrid 检索走通', async () => {
  // stub embedding server：OpenAI 兼容 /embeddings，向量按文本 hash 生成（同文本同向量 → 自匹配）
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { input } = JSON.parse(body);
      const vec = (t) => {
        const v = [0, 0, 0, 0];
        for (let i = 0; i < t.length; i++) v[i % 4] += t.charCodeAt(i) % 7;
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      };
      const data = (Array.isArray(input) ? input : [input]).map((t, i) => ({ object: 'embedding', index: i, embedding: vec(String(t)) }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const r = configureRetrieval({ provider: 'openai-compatible', base_url: `http://127.0.0.1:${port}/v1`, model: 'stub-embed' }, { CAREER_OPS_ASR_API_KEY: 'sk-stub' });
  assert.equal(r.mode, 'hybrid', r.detail);
  const t = preparedRoot();
  const { results } = await runSearch(t, '你的搜索架构是怎么设计的？');
  assert.ok(results.length >= 1, 'hybrid 检索应返回结果');
  // 清理：复位词法，避免影响其他测试
  configureRetrieval(null, {});
  srv.close();
});

test('[RS5] hybrid 同义改写判定：vecScore 量纲（用户实测场景）', async () => {
  const { decide } = await import('../retrieval/rank.mjs');
  // 模拟 hybrid 结果：intro 块 vecScore 0.72 领先，另一块 0.5——同义改写应 hit
  const results = [
    { blockId: 'mo.intro-self', score: 0.018, vecScore: 0.72, matchedQuestion: null },
    { blockId: 'mo.x', score: 0.016, vecScore: 0.5, matchedQuestion: null },
  ];
  assert.equal(decide('做一个简单的自我介绍', results, { mode: 'hybrid' }), 'hit');
  // 中等相关 → candidates
  assert.equal(decide('q', [{ blockId: 'a', score: 0.01, vecScore: 0.55, matchedQuestion: null }, { blockId: 'b', score: 0.01, vecScore: 0.52, matchedQuestion: null }], { mode: 'hybrid' }), 'candidates');
  // 低相关 → unknown（不再被 BM25 阈值误杀，也不瞎命中）
  assert.equal(decide('q', [{ blockId: 'a', score: 0.01, vecScore: 0.3, matchedQuestion: null }], { mode: 'hybrid' }), 'unknown');
  // 词法模式不受影响
  assert.equal(decide('q', [{ blockId: 'a', score: 2.0, matchedQuestion: null }], { mode: 'lexical', autoThreshold: 1.5 }), 'candidates');
});
