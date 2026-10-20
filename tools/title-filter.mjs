#!/usr/bin/env node
/**
 * title-filter.mjs — track-scoped 标题过滤器（从 test-title-filter.mjs 提取的可复用逻辑）。
 *
 * 判定顺序不能颠倒（与 modes/scan.md 的 6b 规则一致）：
 *   1. 命中 title_filter.negative（全局硬红线）任意一条 → drop，与方向无关
 *   2. 对每个 track：命中其 positive ≥1 且未命中其 negative → keep，打 track 标签
 *   3. 没有任何 track 命中 → drop
 *
 * 读 portals.yml；portals.yml 不存在时 fallback 到 templates/portals-china.example.yml。
 * 匹配为大小写不敏感子串（外企岗位标题多为英文，行为与旧测试一致）。
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = join(ROOT, 'portals.yml');
const TEMPLATE = join(ROOT, 'templates', 'portals-china.example.yml');

/** Collect `- "item"` entries under a dotted key path, by indentation. */
function listAt(lines, path) {
  const keys = path.split('.');
  let depth = 0, at = -1;
  for (let i = 0; i < lines.length; i++) {
    const want = '  '.repeat(depth) + keys[depth] + ':';
    if (lines[i].startsWith(want)) {
      depth++;
      if (depth === keys.length) { at = i; break; }
    }
  }
  if (at < 0) return null;
  const out = [];
  for (let j = at + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim().startsWith('- ')) out.push(l.trim().slice(2).trim().replace(/^"|"$/g, ''));
    else if (l.trim() && !l.trim().startsWith('#') && /^\s*[a-z_-]+:/.test(l)) break;
  }
  return out;
}

/** Discover track names under title_filter.track_filters (don't hardcode them). */
function trackNames(lines) {
  const tf = lines.findIndex(l => l.startsWith('title_filter:'));
  const trk = lines.findIndex((l, i) => i > tf && /^  track_filters:\s*$/.test(l));
  if (trk < 0) return [];
  const names = [];
  for (let j = trk + 1; j < lines.length; j++) {
    const m = lines[j].match(/^    ([a-z0-9_-]+):\s*$/);
    if (m) names.push(m[1]);
    else if (lines[j].trim() && /^  [a-z_]+:/.test(lines[j])) break;
  }
  return names;
}

/**
 * 加载过滤器。返回 null = 连 fallback 模板都不存在。
 */
export function loadTitleFilter() {
  const usingLive = existsSync(LIVE);
  const src = usingLive ? LIVE : TEMPLATE;
  if (!existsSync(src)) return null;
  const lines = readFileSync(src, 'utf-8').split('\n');
  return {
    source: usingLive ? 'portals.yml' : 'templates/portals-china.example.yml',
    globalNeg: listAt(lines, 'title_filter.negative') || [],
    tracks: trackNames(lines).map(name => ({
      name,
      positive: listAt(lines, `title_filter.track_filters.${name}.positive`) || [],
      negative: listAt(lines, `title_filter.track_filters.${name}.negative`) || [],
    })),
  };
}

/**
 * 判定一个标题。返回 { keep, tracks: 命中的 track 名, why: 人读原因 }。
 */
export function judgeTitle(title, filter) {
  const hit = (words) => words.filter(w => w && title.toLowerCase().includes(w.toLowerCase()));
  const g = hit(filter.globalNeg);
  if (g.length) return { keep: false, tracks: [], why: `全局红线 [${g.join(', ')}]` };
  const matched = [], why = [];
  for (const t of filter.tracks) {
    const pos = hit(t.positive), neg = hit(t.negative);
    if (pos.length && !neg.length) { matched.push(t.name); why.push(`${t.name} (+${pos.join('/')})`); }
    else if (!pos.length) why.push(`${t.name} 无正向命中`);
    else why.push(`${t.name} 撞 [${neg.join(',')}]`);
  }
  return matched.length
    ? { keep: true, tracks: matched, why: why.filter(w => matched.some(m => w.startsWith(m))).join(' + ') }
    : { keep: false, tracks: [], why: why.join(' / ') };
}
