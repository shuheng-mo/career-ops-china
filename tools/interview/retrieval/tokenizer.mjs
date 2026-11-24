// 检索分词（spec §3.1 检索层）：NFKC 归一 → 中文按字 bigram + 英文/数字 token，小写。
export function normalizeQuery(text) {
  return String(text).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

// 精确命中比较键：NFKC + 小写 + 去空白/标点/符号（与 import 判重同一口径）
export function exactKey(text) {
  return String(text).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

const EN_TOKEN = /[a-z0-9]+/g;
const CJK = /[㐀-鿿豈-﫿]/;

export function tokenize(text) {
  const norm = normalizeQuery(text);
  const tokens = new Set();
  // 英文/数字 token
  for (const m of norm.matchAll(EN_TOKEN)) {
    if (m[0]) tokens.add(m[0]);
  }
  // 中文字符 bigram（忽略英文区间内插进的空格）
  const cjkChars = [...norm].filter((ch) => CJK.test(ch));
  for (let i = 0; i < cjkChars.length - 1; i++) {
    tokens.add(cjkChars[i] + cjkChars[i + 1]);
  }
  // 单个 CJK 字符也保留（问句短时保证召回）
  for (const ch of cjkChars) tokens.add(ch);
  return [...tokens];
}
