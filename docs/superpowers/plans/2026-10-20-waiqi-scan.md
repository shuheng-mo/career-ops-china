# waiqi-scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从神仙外企（waiqi.com）公开 API 抓取匹配候选人方向的外企岗位，连 JD 全文一起落盘 `inbox/`，接入现有 inbox 评估流水线。

**Architecture:** 纯 HTTP 直抓两个已实测的免登录 JSON 接口（列表 + 详情），复用 portals.yml 的 track-scoped title 过滤（提取成独立模块），三重去重后按 bookmarklet JSON schema 写入 `inbox/`。范式完全对齐现有 `tools/tencent-careers.mjs`。

**Tech Stack:** Node.js (mjs, 内置 fetch)、无新依赖、YAML 用现有的行解析方式（不引 yaml 包）。

**Spec:** `docs/superpowers/specs/2026-10-20-waiqi-scan-design.md`

## Global Constraints

- 无新 npm 依赖；只用 Node 内置模块（`node:fs` / `node:path` / `node:url` / 全局 `fetch`）
- 请求节流：页间/详情间 sleep 500ms；失败重试 2 次（退避 1s/2s），单个失败不中断整体
- 只读公开接口；不抓会员内容（联系方式/投递入口）；永不自动投递
- API base：`https://backservice.offerxiansheng.com/api/position-service`
  - 列表：`POST /social-position/foreign/page-list`，body 固定为 `{"page":N,"size":20,"keyword":"","categoryIdList":[],"companyTypeList":[],"sort":0,"type":2,"cityIds":"","posIds":"","status":1}`，成功判 `body.code === 1000`，记录在 `body.data.positionVO.records`，总数 `body.data.count`
  - 详情：`GET /social-position/details?id={id}`，成功判 `body.code === 1000`，JD 在 `body.data.description`
- 岗位 URL 格式：`https://www.waiqi.com/position/detail?id={id}`
- scan-history.tsv 保持现有 6 列：`url\tfirst_seen\tportal\ttitle\tcompany\tstatus`（status ∈ `added`/`skipped_title_filter`/`skipped_dup`）；命中词细节只打印到终端，不进 TSV
- inbox JSON schema 与 `tools/tencent-careers.mjs` 产出一致（`url`/`page_title`/`captured_at`/`platform`/`capture_method`/`extracted{...}`），`platform: "waiqi"`
- 时间戳/文件 slug 用 tencent-careers.mjs 同款约定（北京时间 `YYYYMMDD-HHmmss`、`slugify`）
- 提取 title-filter 后 `node tools/test-title-filter.mjs` 必须保持全绿

---

### Task 1: 提取 `tools/title-filter.mjs` 并让回归测试改 import

**Files:**
- Create: `tools/title-filter.mjs`
- Modify: `tools/test-title-filter.mjs`（整体重写为薄测试壳）

**Interfaces:**
- Produces（Task 2 依赖这两个导出）:
  - `loadTitleFilter()` → `null | { source: 'portals.yml' | 'templates/portals-china.example.yml', globalNeg: string[], tracks: [{ name: string, positive: string[], negative: string[] }] }`（两个文件都不存在时返回 `null`）
  - `judgeTitle(title: string, filter: {globalNeg, tracks})` → `{ keep: boolean, tracks: string[], why: string }`

- [ ] **Step 1: 跑基线回归测试确认全绿**

Run: `node tools/test-title-filter.mjs`
Expected: `通过 16 / 失败 0`（live portals.yml 的 16 个 case 全过）

- [ ] **Step 2: 创建 `tools/title-filter.mjs`**

```js
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
```

- [ ] **Step 3: 重写 `tools/test-title-filter.mjs` 为薄测试壳**

保留原头部注释（解释为什么过滤器是 track-scoped 的，那是重要的设计记录），正文替换为：

```js
#!/usr/bin/env node
/**
 * test-title-filter.mjs — Regression test for the track-scoped title filter.
 *
 *（保留原文件头部注释全文，说明为什么全局合取规则在双方向下会双向毙掉岗位、
 *  为什么方向红线必须挪进各自 track。）
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
```

- [ ] **Step 4: 跑回归测试确认提取后仍全绿**

Run: `node tools/test-title-filter.mjs`
Expected: `通过 16 / 失败 0`，输出格式与 Step 1 基线一致

- [ ] **Step 5: Commit**

```bash
git add tools/title-filter.mjs tools/test-title-filter.mjs
git commit -m "refactor: 提取 track-scoped title 过滤器为可复用模块 tools/title-filter.mjs"
```

---

### Task 2: `tools/waiqi-scan.mjs` 主工具

**Files:**
- Create: `tools/waiqi-scan.mjs`

**Interfaces:**
- Consumes: `loadTitleFilter()` / `judgeTitle(title, filter)`（Task 1）
- Produces: CLI `node tools/waiqi-scan.mjs [--max-pages N] [--dry-run] [--since YYYY-MM-DD]`；产出 `inbox/jd-{ts}-waiqi-{slug}.json` + 追加 `data/scan-history.tsv` 行

- [ ] **Step 1: 创建 `tools/waiqi-scan.mjs`**

```js
#!/usr/bin/env node
/**
 * waiqi-scan.mjs — pull matching postings from waiqi.com (神仙外企) into inbox/.
 *
 * waiqi.com/position is a Vue SPA over a public, login-free JSON API:
 * the list endpoint returns every 外企官方渠道 posting, the detail endpoint
 * returns the full company-official JD. Nothing to scrape in a browser.
 *
 *   node tools/waiqi-scan.mjs                     # 全量：列表→过滤→去重→拉JD→写 inbox/
 *   node tools/waiqi-scan.mjs --max-pages 3       # 只拉前 3 页列表
 *   node tools/waiqi-scan.mjs --since 2026-10-18  # 只看 updateTime >= 该日期的岗位
 *   node tools/waiqi-scan.mjs --dry-run           # 只统计，不写 inbox / scan-history
 *
 * 过滤：tools/title-filter.mjs（portals.yml 的 track-scoped 规则，与 scan 模式同一套）。
 * 去重：scan-history.tsv URL + inbox/processed 已抓 id + applications.md 公司·岗位 + pipeline.md URL。
 * 节流：请求间隔 500ms，失败重试 2 次。手动低频运行，只读公开数据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTitleFilter, judgeTitle } from './title-filter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INBOX = path.join(ROOT, 'inbox');
const HISTORY = path.join(ROOT, 'data', 'scan-history.tsv');
const APPLICATIONS = path.join(ROOT, 'data', 'applications.md');
const PIPELINE = path.join(ROOT, 'data', 'pipeline.md');
const API = 'https://backservice.offerxiansheng.com/api/position-service';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  'Content-Type': 'application/json',
  Origin: 'https://www.waiqi.com',
  Referer: 'https://www.waiqi.com/position',
};
const DELAY_MS = 500;
const PAGE_SIZE = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries) throw e; await sleep(1000 * i); }
  }
}

async function listPage(page) {
  const res = await fetch(`${API}/social-position/foreign/page-list`, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({
      page, size: PAGE_SIZE, keyword: '', categoryIdList: [], companyTypeList: [],
      sort: 0, type: 2, cityIds: '', posIds: '', status: 1,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} page-list p${page}`);
  const body = await res.json();
  if (body.code !== 1000) throw new Error(`page-list p${page}: code ${body.code} ${body.message || ''}`);
  return body.data; // { count, positionVO: { records } }
}

async function detail(id) {
  const res = await fetch(`${API}/social-position/details?id=${id}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} details ${id}`);
  const body = await res.json();
  if (body.code !== 1000) throw new Error(`details ${id}: code ${body.code} ${body.message || ''}`);
  return body.data;
}

const jobUrl = (id) => `https://www.waiqi.com/position/detail?id=${id}`;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

// ---------- 去重源 ----------

/** waiqi ids already captured in inbox/ or inbox/processed/. */
function capturedIds() {
  const ids = new Set();
  for (const dir of [INBOX, path.join(INBOX, 'processed')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const { url = '' } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const id = url.match(/waiqi\.com\/position\/detail\?id=(\d+)/)?.[1];
        if (id) ids.add(id);
      } catch {}
    }
  }
  return ids;
}

/** URLs already recorded in scan-history.tsv (first column). */
function historyUrls() {
  const urls = new Set();
  if (!fs.existsSync(HISTORY)) return urls;
  for (const line of fs.readFileSync(HISTORY, 'utf8').split('\n').slice(1)) {
    const url = line.split('\t')[0];
    if (url && url.startsWith('http')) urls.add(url);
  }
  return urls;
}

/** URLs sitting in pipeline.md, plus 公司|岗位 keys and URLs from applications.md. */
function trackerKeys() {
  const urls = new Set(), keys = new Set();
  if (fs.existsSync(PIPELINE)) {
    for (const m of fs.readFileSync(PIPELINE, 'utf8').matchAll(/https?:\/\/[^\s|]+/g)) urls.add(m[0]);
  }
  if (fs.existsSync(APPLICATIONS)) {
    for (const line of fs.readFileSync(APPLICATIONS, 'utf8').split('\n')) {
      if (!line.startsWith('|') || /^\|\s*-/.test(line) || line.includes('Company')) continue;
      const cols = line.split('|').map((c) => c.trim()).filter(Boolean);
      if (cols.length < 4 || !/^\d+$/.test(cols[0])) continue;
      keys.add(`${norm(cols[2])}|${norm(cols[3])}`); // Company | Role
      const url = (cols[7] || '').match(/https?:\/\/[^\s)]+/)?.[0];
      if (url) urls.add(url);
    }
  }
  return { urls, keys };
}

// ---------- inbox 落盘（与 tools/tencent-careers.mjs 同约定） ----------

function slugify(s, max = 40) {
  if (!s) return 'unknown';
  return s.replace(/[\/\\<>:"|?*\x00-\x1f#]/g, '').replace(/\s+/g, '-').slice(0, max).trim() || 'unknown';
}
function timestamp() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

function fmtSalary(rec, det) {
  const min = det.salaryMin ?? rec.salaryMin, max = det.salaryMax ?? rec.salaryMax;
  if (min && max) return `${min}-${max}`;
  if ((det.negotiable ?? rec.negotiable) === 1) return '面议';
  return '';
}

function saveToInbox(rec, det) {
  const payload = {
    url: jobUrl(rec.id),
    page_title: `${rec.name}_${rec.companyName}_神仙外企`,
    captured_at: new Date().toISOString(),
    platform: 'waiqi',
    capture_method: 'tools/waiqi-scan.mjs (backservice.offerxiansheng.com API)',
    extracted: {
      job_title: rec.name,
      company: rec.companyName,
      salary: fmtSalary(rec, det),
      location: det.cityNamelist || rec.cityNameList || '',
      seniority_experience: [det.workExpName || rec.workExpName, det.educationName || rec.educationName].filter(Boolean).join(' · '),
      description: (det.description || '').trim(),
      requirements: [rec.posCategoryName, rec.posInfoName, ...(rec.tagNameList || [])].filter(Boolean).join('；'),
      raw_text: '',
    },
  };
  fs.mkdirSync(INBOX, { recursive: true });
  let file = `jd-${timestamp()}-waiqi-${slugify(rec.name)}.json`;
  for (let n = 2; fs.existsSync(path.join(INBOX, file)); n++) file = file.replace(/(-\d+)?\.json$/, `-${n}.json`);
  fs.writeFileSync(path.join(INBOX, file), JSON.stringify(payload, null, 2), 'utf8');
  return `inbox/${file}`;
}

// ---------- 主流程 ----------

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
};
const maxPages = Number(opt('max-pages') || Infinity);
const dryRun = argv.includes('--dry-run');
const since = opt('since') || null;

const filter = loadTitleFilter();
if (!filter) { console.error('❌ 找不到 portals.yml 或模板，无法加载 title_filter'); process.exit(1); }
if (filter.tracks.length === 0) { console.error('❌ title_filter.track_filters 缺失'); process.exit(1); }

// 1. 拉列表
const records = [];
let total = 0, lastPage = 0;
for (let page = 1; page <= maxPages; page++) {
  if (page > 1) await sleep(DELAY_MS);
  try {
    const data = await withRetry(() => listPage(page));
    const batch = data.positionVO?.records || [];
    total = data.count || 0;
    records.push(...batch);
    lastPage = page;
    if (!batch.length || records.length >= total) break;
  } catch (e) {
    console.log(`⚠️ 第 ${page} 页拉取失败（${e.message}），已拿 ${records.length} 条，继续`);
    break;
  }
}
const seenId = new Set();
const unique = records.filter((r) => !seenId.has(r.id) && seenId.add(r.id));

// 2. --since 时间过滤（list 的 updateTime 形如 "2026-10-20"，字典序可比）
const dated = since ? unique.filter((r) => String(r.updateTime || '') >= since) : unique;

// 3+4. 标题过滤 + 去重
const dupIds = capturedIds();
const hist = historyUrls();
const tracker = trackerKeys();
const kept = [], droppedTitle = [], droppedDup = [];
for (const rec of dated) {
  const verdict = judgeTitle(rec.name || '', filter);
  if (!verdict.keep) { droppedTitle.push({ rec, verdict }); continue; }
  const url = jobUrl(rec.id);
  if (hist.has(url) || dupIds.has(String(rec.id)) || tracker.urls.has(url)
      || tracker.keys.has(`${norm(rec.companyName)}|${norm(rec.name)}`)) {
    droppedDup.push(rec);
    continue;
  }
  kept.push({ rec, verdict });
}

// 5+6. 拉详情 + 落盘
const added = [], shortJd = [], detailFail = [];
for (const { rec, verdict } of kept) {
  await sleep(DELAY_MS);
  try {
    const det = await withRetry(() => detail(rec.id));
    const desc = (det.description || '').trim();
    if (desc.length < 100) shortJd.push(rec);
    if (!dryRun) added.push({ file: saveToInbox(rec, det), rec, verdict });
    else added.push({ file: '(dry-run)', rec, verdict });
  } catch (e) {
    detailFail.push({ rec, err: e.message });
  }
}

// 7. scan-history（已进历史的 URL 不重写）
if (!dryRun) {
  const rows = [];
  const push = (rec, status) => {
    const url = jobUrl(rec.id);
    if (hist.has(url)) return;
    rows.push(`${url}\t${today()}\twaiqi\t${(rec.name || '').replace(/\t/g, ' ')}\t${(rec.companyName || '').replace(/\t/g, ' ')}\t${status}`);
    hist.add(url);
  };
  for (const { rec } of added) push(rec, 'added');
  for (const { rec } of detailFail) push(rec, 'added'); // 已见过，避免下次重复拉详情失败
  for (const { rec } of droppedTitle) push(rec, 'skipped_title_filter');
  for (const rec of droppedDup) push(rec, 'skipped_dup');
  if (rows.length) fs.appendFileSync(HISTORY, rows.join('\n') + '\n', 'utf8');
}

// 8. 摘要
const trackStat = {};
for (const { verdict } of kept) for (const t of verdict.tracks) trackStat[t] = (trackStat[t] || 0) + 1;
console.log(`
神仙外企 waiqi-scan — ${today()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
拉取列表：${unique.length} 条（page 1..${lastPage}${maxPages !== Infinity ? `，--max-pages ${maxPages}` : ''}，站点共 ${total} 条）
${since ? `--since ${since} 后：${dated.length} 条\n` : ''}标题过滤 keep：${kept.length}（${Object.entries(trackStat).map(([t, n]) => `${t}: ${n}`).join(' · ') || '—'}）
标题过滤 drop：${droppedTitle.length}
去重跳过：${droppedDup.length}
拉详情失败：${detailFail.length}${shortJd.length ? `\n⚠️ JD 过短(<100字)：${shortJd.length}（已照常落盘，inbox triage 时留意）` : ''}
${dryRun ? '\n(dry-run，未写任何文件)' : `新写入 inbox/：${added.filter((a) => a.file !== '(dry-run)').length} 个 JSON
→ 回 Claude 跑 /career-ops inbox`}`);
if (dryRun || process.env.WAIQI_VERBOSE) {
  for (const { rec, verdict } of kept.slice(0, 50)) console.log(`  KEEP [${verdict.tracks.join('+')}] ${rec.companyName} | ${rec.name} | ${rec.cityNameList || ''}`);
}
if (detailFail.length) for (const { rec, err } of detailFail) console.log(`  ❌ ${rec.name}: ${err}`);
```

- [ ] **Step 2: 冒烟 — dry-run 只拉 2 页**

Run: `node tools/waiqi-scan.mjs --dry-run --max-pages 2`
Expected:
- 退出码 0
- 输出含 `拉取列表：40 条`（2 页 × 20）
- keep/drop/去重计数合理，dry-run 行列出 KEEP 明细
- 明确打印 `(dry-run，未写任何文件)`
- `git status` 确认 `inbox/` 和 `data/scan-history.tsv` 无变化

- [ ] **Step 3: 实跑全量**

Run: `node tools/waiqi-scan.mjs`
Expected:
- 拉取列表约 1040 条，无请求失败（或仅个别详情失败并被计数）
- `inbox/` 新增若干 `jd-*-waiqi-*.json`
- `data/scan-history.tsv` 追加了对应行（portal 列 = `waiqi`）

- [ ] **Step 4: 校验 inbox JSON 符合 schema**

Run:
```bash
f=$(ls -t inbox/jd-*-waiqi-*.json | head -1) && node -e "
const j = JSON.parse(require('fs').readFileSync('$f','utf8'));
const need = ['url','page_title','captured_at','platform','extracted'];
for (const k of need) if (!(k in j)) throw new Error('missing '+k);
const e = j.extracted;
for (const k of ['job_title','company','salary','location','seniority_experience','description','requirements','raw_text'])
  if (!(k in e)) throw new Error('missing extracted.'+k);
if (j.platform !== 'waiqi') throw new Error('platform');
if (!j.url.includes('waiqi.com/position/detail?id=')) throw new Error('url');
if (e.description.length < 100) console.log('⚠️ description 较短:', e.description.length, '字');
console.log('✅ schema OK:', j.extracted.company, '|', j.extracted.job_title, '| JD', e.description.length, '字');
"
```
Expected: `✅ schema OK: ...`

- [ ] **Step 5: 验证幂等 — 立即重跑应全部去重**

Run: `node tools/waiqi-scan.mjs --max-pages 2`
Expected: `去重跳过` 计数等于 keep 数，`新写入 inbox/：0 个 JSON`（scan-history 已有这些 URL）

- [ ] **Step 6: Commit**

```bash
git add tools/waiqi-scan.mjs
git commit -m "feat: tools/waiqi-scan.mjs 神仙外企岗位抓取 → inbox（公开 API + title 过滤 + 三重去重）"
```

（inbox JSON 和 scan-history 数据文件是否提交遵循仓库既有习惯：inbox/processed 在版本库内，新抓的 JSON 可留待 `/career-ops inbox` 处理后随处理结果一起提交。）

---

### Task 3: 接线 — npm script + CLAUDE.md 登记

**Files:**
- Modify: `package.json`（scripts 段）
- Modify: `CLAUDE.md`（Main Files 表）

**Interfaces:**
- Consumes: Task 2 的 CLI
- Produces: `npm run waiqi` 可用

- [ ] **Step 1: package.json 加 script**

在 `"tencent": "node tools/tencent-careers.mjs"` 后加一行：

```json
    "tencent": "node tools/tencent-careers.mjs",
    "waiqi": "node tools/waiqi-scan.mjs"
```

- [ ] **Step 2: CLAUDE.md Main Files 表加一行**

在 `tools/cv-md-to-pdf.mjs` 行附近加：

```markdown
| `tools/waiqi-scan.mjs` | 神仙外企岗位抓取 → inbox（`npm run waiqi`，可选 `--max-pages N` / `--since` / `--dry-run`） |
```

- [ ] **Step 3: 验证 npm script**

Run: `npm run waiqi -- --dry-run --max-pages 1`
Expected: 正常输出统计，退出码 0

- [ ] **Step 4: Commit**

```bash
git add package.json CLAUDE.md
git commit -m "chore: 接线 npm run waiqi + CLAUDE.md 登记 waiqi-scan"
```

---

## Self-Review 记录

- **Spec coverage**：列表拉取 ✅(T2S1) / --since ✅(T2S1) / title 过滤复用 ✅(T1+T2) / 三重去重+inbox 去重 ✅(T2S1 dedup 函数) / 详情重试 ✅(withRetry) / inbox 落盘 ✅ / scan-history ✅ / 摘要输出 ✅ / dry-run 冒烟 ✅(T2S2) / test-title-filter 回归 ✅(T1S4) / npm script ✅(T3)
- **Placeholder scan**：无 TBD/TODO；所有代码完整给出
- **Type consistency**：`loadTitleFilter()` 返回 `{source, globalNeg, tracks}`，T1 测试与 T2 主工具消费一致；`judgeTitle` 返回 `{keep, tracks, why}`，两处用法一致；`trackStat` 用 `verdict.tracks`（数组）正确
- **spec 偏差说明**：spec 说 scan-history「备注命中词」——现有 TSV 只有 6 列无 notes 列，命中词改为打印到终端摘要，不破坏文件格式
