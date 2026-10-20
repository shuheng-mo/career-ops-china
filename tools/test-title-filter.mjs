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
 * 过滤逻辑本体在 tools/title-filter.mjs；这里只跑回归 case。
 * Run: node tools/test-title-filter.mjs   (or: npm run test:filter)
 * Exits non-zero on any failure.
 */

import { loadTitleFilter, judgeTitle } from './title-filter.mjs';

const filter = loadTitleFilter();
if (!filter) {
  console.log('⏭  Neither portals.yml nor the template exists — nothing to test.');
  process.exit(0);
}
const usingLive = filter.source === 'portals.yml';

if (filter.tracks.length === 0) {
  console.error('❌ title_filter.track_filters not found — the filter is still the old flat shape.');
  console.error('   See the header comment in this file for why that breaks multi-direction search.');
  process.exit(1);
}

console.log(`源: ${usingLive ? 'portals.yml' : 'templates/portals-china.example.yml (fallback)'}`);
console.log(`全局红线 ${filter.globalNeg.length} 条 | tracks: ${filter.tracks.map(t => `${t.name}(+${t.positive.length}/-${t.negative.length})`).join(' ')}\n`);

// Cases only assert on the live config: the template ships one example track,
// so automotive cases cannot pass there.
const cases = usingLive ? [
  ['某车企 — AI Agents 开发工程师', true],
  ['理想汽车 — 智能座舱 AI 应用工程师', true],
  ['Momenta — 智驾数据闭环工程师（自动标注/场景挖掘）', true],
  ['地平线 — BEV 感知算法工程师', true],
  ['极氪 — 车云后端开发工程师（智驾数据平台）', true],
  ['某车企 — 车端模型部署/推理优化工程师', true],
  ['某智驾公司 — 嵌入式软件工程师（域控）', true],
  ['字节跳动 — AI Agent 研发工程师', true],
  ['某互联网公司 — 后端开发工程师（Java）', false],
  ['某公司 — 大数据开发工程师（数仓）', false],
  ['某车企 — 车规芯片验证工程师', false],
  ['某智驾 — 数据标注专员', false],
  ['某公司 — AI 应用开发实习生', false],
  ['某公司 — 智能体套件-全栈开发工程师-CodeBuddy', true],
  ['某公司 — ai开发工程师', true],
  ['某公司 — AI 应用工程师（OD）', false],
] : [
  ['某公司 — 数据工程师', true],
  ['某公司 — AI 应用开发实习生', false],
];

let pass = 0, fail = 0;
for (const [title, want] of cases) {
  const r = judgeTitle(title, filter);
  const ok = r.keep === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${r.keep ? 'KEEP' : 'DROP'}  ${title}`);
  console.log(`     ${r.why}`);
  if (!ok) console.log(`     ⚠️ 预期 ${want ? 'KEEP' : 'DROP'}`);
}
console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
