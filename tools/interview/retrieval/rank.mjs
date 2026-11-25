// 定位决策（spec §9.2 决策段的 P1 离线版 + v26 e2e 后的噪声适配）：
// - 精确归一文本等于某块唯一 question/alias → hit（自动确认，不受阈值影响）
// - loose 子句层：真实转写是多 utterance 拼接的噪声文本，永远不与 question 精确相等
//   （v26 35 问实测 0 hit）。切子句、去语气词后与块 question 归一比较，唯一且为 top1 → hit
// - 分数统治层：top1 分数绝对高（≥6）且 ≥3×top2 → hit（alias 词全命中时分数爆炸，
//   如 v26 q002 的 12.79 vs 2.45；弱相关错配一般在 2-3 分区间，不满足统治线）
// - top 分数低于保守阈值 → unknown；其余 → candidates（展示给人工）
import { exactKey } from './tokenizer.mjs';

const FILLER = /^(嗯+|啊+|哎+|呃+|噢+|哦+|对|OK|Okay|好|就是|我想一下啊?|那个|这个)+[，。、\s]*/;

function looseClauses(text) {
  return String(text)
    .split(/[\/；;？?。.\n，,、]+/)
    .map((s) => s.replace(FILLER, '').replace(FILLER, '').trim())
    .filter((s) => s.length >= 4)
    .map((s) => exactKey(s));
}

function looseMatches(query, results) {
  const clauses = looseClauses(query);
  if (!clauses.length) return [];
  return results.filter((r) => {
    if (!r.matchedQuestion) return false;
    const qk = r.matchedQuestion;
    return clauses.some((c) => c === qk || (qk.length >= 6 && c.includes(qk)));
  });
}

export function decide(query, results, { autoThreshold = 1.5 } = {}) {
  if (!results.length) return 'unknown';
  const normQuery = exactKey(query);
  const exactMatches = results.filter((r) => r.matchedQuestion === normQuery);
  if (exactMatches.length === 1) return 'hit';
  if (exactMatches.length > 1) return 'candidates';
  const loose = looseMatches(query, results);
  if (loose.length === 1 && loose[0] === results[0]) return 'hit'; // 唯一且与 BM25 top1 一致（防错位）
  if (loose.length > 1) return 'candidates';
  const [t1, t2] = results;
  if ((t1.score || 0) >= 6 && (t1.score || 0) >= (t2?.score || 0) * 3) return 'hit';
  if ((t1.score || 0) < autoThreshold) return 'unknown';
  return 'candidates';
}

// 语料规模感知阈值：BM25 idf 随 N 缩放，单块语料（N=1）的正常命中分约 1-1.5，
// 常数阈值 1.5 会把它们误判 unknown。对数缩放 + 下限 0.5（标注集校准前的启发式）。
export function autoThresholdFor(index) {
  return Math.max(0.5, Math.log((index?.N || 1) + 1) * 1.2);
}
