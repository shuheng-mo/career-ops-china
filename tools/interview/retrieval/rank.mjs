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
