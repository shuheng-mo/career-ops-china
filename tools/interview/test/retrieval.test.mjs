import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, normalizeQuery, exactKey } from '../retrieval/tokenizer.mjs';
import { buildIndex, search } from '../retrieval/bm25.mjs';
import { decide } from '../retrieval/rank.mjs';

const BLOCKS = [
  {
    block_id: 'demo.query-permission',
    frontMatter: {
      questions: ['你如何限制查询权限？', '怎样防止越权读取数据？'],
      anchors: ['权限过滤', '执行校验'],
      project: 'demo',
    },
    body: '## 30 秒版\n先做身份识别，再按角色过滤表和列。\n## 详细版\n虚构。',
  },
  {
    block_id: 'demo.routing',
    frontMatter: {
      questions: ['多模型路由是怎么设计的？'],
      anchors: ['成本', 'fallback'],
      project: 'demo',
    },
    body: '## 30 秒版\n按查询复杂度分流到不同模型。\n## 详细版\n虚构。',
  },
];

test('tokenize：中文 bigram + 英文 token + NFKC 小写', () => {
  const tokens = tokenize('查询权限 LangGraph');
  assert.ok(tokens.includes('查询'), tokens.join(','));
  assert.ok(tokens.includes('询权'));
  assert.ok(tokens.includes('权限'));
  assert.ok(tokens.includes('langgraph'));
  // NFKC：全角字母归一
  assert.ok(tokenize('Ｌａｎｇ').includes('lang'));
});

test('search：语义相近问句 top1 命中目标块', () => {
  const index = buildIndex(BLOCKS);
  const results = search(index, '怎么限制查询权限', { topK: 5 });
  assert.ok(results.length >= 1);
  assert.equal(results[0].blockId, 'demo.query-permission');
});

test('decide：完全无关 → unknown（不给候选）', () => {
  const index = buildIndex(BLOCKS);
  const results = search(index, '今天天气怎么样', { topK: 5 });
  assert.equal(decide('今天天气怎么样', results, {}), 'unknown');
});

test('decide：精确同义问唯一 → hit；两块同问 → candidates', () => {
  const index = buildIndex(BLOCKS);
  const exact = search(index, '你如何限制查询权限', { topK: 5 });
  assert.equal(decide('你如何限制查询权限', exact, {}), 'hit');
  const dupBlocks = [
    { block_id: 'a.q1', frontMatter: { questions: ['什么是 BM25？'], anchors: [] }, body: '' },
    { block_id: 'b.q1', frontMatter: { questions: ['什么是BM25？'], anchors: [] }, body: '' },
  ];
  const dupIndex = buildIndex(dupBlocks);
  const dupResults = search(dupIndex, '什么是BM25', { topK: 5 });
  assert.equal(decide('什么是BM25', dupResults, {}), 'candidates');
  assert.equal(exactKey('什么是ＢＭ２５？'), exactKey('什么是bm25'));
});

test('autoThresholdFor 随语料规模缩放（单块语料正常命中不误判 unknown）', async () => {
  const { autoThresholdFor } = await import('../retrieval/rank.mjs');
  const { buildIndex } = await import('../retrieval/bm25.mjs');
  const one = buildIndex([{ block_id: 'a', frontMatter: { questions: ['你如何限制查询权限？'], anchors: [] }, body: '' }]);
  const th1 = autoThresholdFor(one);
  assert.ok(th1 >= 0.5 && th1 < 1.4, `N=1 阈值 ${th1}`);
  const r = search(one, '怎么限制查询权限', { topK: 5 });
  assert.equal(decide('怎么限制查询权限', r, { autoThreshold: th1 }), 'candidates');
  assert.equal(decide('今天天气怎么样', search(one, '今天天气怎么样', { topK: 5 }), { autoThreshold: th1 }), 'unknown');
});

test('[R.loose] 真实转写噪声下 alias 仍自动命中（v26 q002 原文）', async () => {
  const { buildIndex, search } = await import('../retrieval/bm25.mjs');
  const { decide } = await import('../retrieval/rank.mjs');
  const blocks = [
    { block_id: 'a.story', frontMatter: { questions: ['讲一下 Elytra 这个项目：背景、你做了什么、结果如何'], anchors: ['分层库'] }, body: '按真实数仓形态设计' },
    { block_id: 'a.contrib', frontMatter: { questions: ['在 Elytra 里你个人的具体贡献是什么', '你的搜索架构是什么？', 'NN 的搜索架构是怎么做的？'], anchors: ['BM25'] }, body: '混合检索 BM25 向量 cross-encoder' },
  ];
  const idx = buildIndex(blocks);
  const noisy = '啊，那这部分这部分你们就是。 / 框架是什么？ / 架构是什么？ / 你的 NN 的搜索架构是什么？';
  const r = search(idx, noisy);
  const d = decide(noisy, r, { autoThreshold: 1.5 });
  assert.equal(d, 'hit', '噪声拼接原文应 loose 命中');
  assert.equal(r[0].blockId, 'a.contrib', 'loose 命中块应为 top1');
});

test('[R.loose] 语义错配的弱相关候选不升级 hit（v26 q003 原文）', async () => {
  const { buildIndex, search } = await import('../retrieval/bm25.mjs');
  const { decide } = await import('../retrieval/rank.mjs');
  const blocks = [
    { block_id: 'p.story', frontMatter: { questions: ['讲一下 Pawgrino 这个项目：背景、你做了什么、结果如何'], anchors: ['多 Agent'] }, body: '旅行规划系统 三模式融合' },
  ];
  const idx = buildIndex(blocks);
  const q3 = 'OK，那这原始方案的问题是什么呢？ / 你们应该没有用原始的方案，应该还是做了一些优化。';
  const r = search(idx, q3);
  const d = decide(q3, r, { autoThreshold: 0.5 });
  assert.notEqual(d, 'hit', '弱相关不得自动命中');
});
