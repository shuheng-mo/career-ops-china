// 内存 BM25 索引（spec §3.1）：语料 = questions + anchors + project + 正文首段。
// 语料刻意不含长答案全文，避免长答案主导排名。
import { exactKey, tokenize } from './tokenizer.mjs';

const K1 = 1.2;
const B = 0.75;

// 计分只用 bigram/英文 token：单字 CJK 是噪声源（任何含「么/样」的问句都会沾分）
const scoringTokens = (tokens) => tokens.filter((t) => t.length > 1);

function blockCorpus(block) {
  const fm = block.frontMatter || {};
  const parts = [];
  for (const q of fm.questions || []) parts.push(q);
  for (const a of fm.anchors || []) parts.push(a);
  if (fm.project) parts.push(fm.project);
  if (fm.intent_key) parts.push(fm.intent_key);
  // 正文首段（30 秒版第一行）
  const first = (block.body || '').split(/\n## /)[0].replace(/^#\+.*\n/, '');
  if (first.trim()) parts.push(first.trim());
  return parts.join('\n');
}

export function buildIndex(blocks) {
  const docs = blocks.map((b) => {
    const text = blockCorpus(b);
    return {
      blockId: b.block_id,
      questions: (b.frontMatter.questions || []).map(exactKey),
      tokens: tokenize(text),
    };
  });
  const df = new Map();
  for (const d of docs) {
    for (const t of new Set(d.tokens)) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const avgLen = docs.reduce((s, d) => s + d.tokens.length, 0) / Math.max(docs.length, 1);
  return { docs, df, avgLen, N: docs.length };
}

export function search(index, query, { topK = 5 } = {}) {
  const qTokens = scoringTokens(tokenize(query));
  const normQuery = exactKey(query);
  const scores = index.docs.map((doc) => {
    let score = 0;
    const counts = new Map();
    for (const t of doc.tokens) counts.set(t, (counts.get(t) || 0) + 1);
    let bestQuestion = null;
    for (const t of qTokens) {
      const tf = counts.get(t) || 0;
      if (!tf) continue;
      const n = index.df.get(t) || 0;
      const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
      score += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * doc.tokens.length / index.avgLen));
    }
    // 记录命中的最佳问句（供 rank.decide 判断精确命中）
    for (const q of doc.questions) {
      if (q === normQuery) bestQuestion = q;
    }
    return { blockId: doc.blockId, score, matchedQuestion: bestQuestion };
  });
  return scores
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
