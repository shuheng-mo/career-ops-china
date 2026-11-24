// 定位决策（spec §9.2 决策段的 P1 离线版）：
// - 精确归一文本等于某块唯一 question/alias → hit（自动确认，不受阈值影响）
// - top 分数低于保守阈值 → unknown（BM25 分数量纲下，单 bigram 巧合命中约 0.5-1.0，
//   多 token 实质命中 ≥2；阈值后续用标注集校准，见规格 §9.2）
// - 其余 → candidates（展示给人工，P1 不自动跳）
import { exactKey } from './tokenizer.mjs';

export function decide(query, results, { autoThreshold = 1.5 } = {}) {
  if (!results.length) return 'unknown';
  const normQuery = exactKey(query);
  const exactMatches = results.filter((r) => r.matchedQuestion === normQuery);
  if (exactMatches.length === 1) return 'hit';
  if (exactMatches.length > 1) return 'candidates';
  if ((results[0].score || 0) < autoThreshold) return 'unknown';
  return 'candidates';
}

// 语料规模感知阈值：BM25 idf 随 N 缩放，单块语料（N=1）的正常命中分约 1-1.5，
// 常数阈值 1.5 会把它们误判 unknown。对数缩放 + 下限 0.5（标注集校准前的启发式）。
export function autoThresholdFor(index) {
  return Math.max(0.5, Math.log((index?.N || 1) + 1) * 1.2);
}
