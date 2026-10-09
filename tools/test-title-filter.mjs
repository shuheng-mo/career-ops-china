#!/usr/bin/env node
/**
 * test-title-filter.mjs — Regression test for the track-scoped title filter.
 *
 * portals.yml's title_filter used to be one flat table judged by a global
 * "positive >= 1 AND negative == 0" conjunction. The moment you run a second
 * job-search direction, that rule kills the new direction from both sides: its
 * JDs match none of the first direction's positive terms, and they necessarily
 * hit the first direction's negatives (hunting for autonomous-driving roles,
 * every JD carries 嵌入式 / 车端部署 / 推理优化 / 服务端 — words that were put
 * there to screen out plain web-backend roles).
 *
 * So adding words to `positive` does NOT fix it. The direction-specific
 * negatives have to move out of the global list and into their own track.
 * This test pins that down in both directions:
 *   - second-direction JDs survive, including ones the old rule killed
 *   - the first direction's red lines still kill what they were meant to kill
 *
 * Reads portals.yml; falls back to templates/portals-china.example.yml so the
 * test still runs on a fresh clone (portals.yml is gitignored).
 *
 * Run: node tools/test-title-filter.mjs   (or: npm run test:filter)
 * Exits non-zero on any failure.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = join(ROOT, 'portals.yml');
const TEMPLATE = join(ROOT, 'templates', 'portals-china.example.yml');

const usingLive = existsSync(LIVE);
const src = usingLive ? LIVE : TEMPLATE;
if (!existsSync(src)) {
  console.log('⏭  Neither portals.yml nor the template exists — nothing to test.');
  process.exit(0);
}
const lines = readFileSync(src, 'utf-8').split('\n');

/** Collect `- "item"` entries under a dotted key path, by indentation. */
function listAt(path) {
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
function trackNames() {
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

const globalNeg = listAt('title_filter.negative') || [];
const tracks = trackNames().map(name => ({
  name,
  positive: listAt(`title_filter.track_filters.${name}.positive`) || [],
  negative: listAt(`title_filter.track_filters.${name}.negative`) || [],
}));

if (tracks.length === 0) {
  console.error('❌ title_filter.track_filters not found — the filter is still the old flat shape.');
  console.error('   See the header comment in this file for why that breaks multi-direction search.');
  process.exit(1);
}

console.log(`源: ${usingLive ? 'portals.yml' : 'templates/portals-china.example.yml (fallback)'}`);
console.log(`全局红线 ${globalNeg.length} 条 | tracks: ${tracks.map(t => `${t.name}(+${t.positive.length}/-${t.negative.length})`).join(' ')}\n`);

const hit = (title, words) => words.filter(w => w && title.toLowerCase().includes(w.toLowerCase()));

function judge(title) {
  const g = hit(title, globalNeg);
  if (g.length) return { keep: false, why: `全局红线 [${g.join(', ')}]` };
  const matched = [], why = [];
  for (const t of tracks) {
    const pos = hit(title, t.positive), neg = hit(title, t.negative);
    if (pos.length && !neg.length) matched.push(`${t.name} (+${pos.join('/')})`);
    else if (!pos.length) why.push(`${t.name} 无正向命中`);
    else why.push(`${t.name} 撞 [${neg.join(',')}]`);
  }
  return matched.length
    ? { keep: true, why: matched.join(' + ') }
    : { keep: false, why: why.join(' / ') };
}

// Cases only assert on the live config: the template ships one example track,
// so automotive cases cannot pass there.
const cases = usingLive ? [
  ['小鹏汽车 — AI Agents开发工程师', true],
  ['理想汽车 — 智能座舱 AI 应用工程师', true],
  ['Momenta — 智驾数据闭环工程师（自动标注/场景挖掘）', true],
  ['地平线 — BEV 感知算法工程师', true],
  ['极氪 — 车云后端开发工程师（智驾数据平台）', true],   // 旧规则下被「后端开发」毙
  ['某车企 — 车端模型部署/推理优化工程师', true],         // 旧规则下被「推理优化」毙
  ['某智驾公司 — 嵌入式软件工程师（域控）', true],         // 旧规则下被「嵌入式」毙
  ['字节跳动 — AI Agent 研发工程师', true],
  ['某互联网公司 — 后端开发工程师（Java）', false],        // AI 轨红线仍要生效
  ['某公司 — 大数据开发工程师（数仓）', false],            // 纯数仓仍 SKIP
  ['某车企 — 车规芯片验证工程师', false],                  // 全局红线
  ['某智驾 — 数据标注专员', false],                        // auto 轨红线
  ['某公司 — AI 应用开发实习生', false],                   // 全局红线（实习）
] : [
  ['某公司 — 数据工程师', true],
  ['某公司 — AI 应用开发实习生', false],
];

let pass = 0, fail = 0;
for (const [title, want] of cases) {
  const r = judge(title);
  const ok = r.keep === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${r.keep ? 'KEEP' : 'DROP'}  ${title}`);
  console.log(`     ${r.why}`);
  if (!ok) console.log(`     ⚠️ 预期 ${want ? 'KEEP' : 'DROP'}`);
}
console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
