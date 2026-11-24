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
