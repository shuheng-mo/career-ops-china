#!/usr/bin/env node
/**
 * waiqi-scan.mjs — pull matching postings from waiqi.com (神仙外企) into inbox/.
 *
 * waiqi.com/position is a Vue SPA over a public, login-free JSON API:
 * the list endpoint returns every 外企官方渠道 posting, the detail endpoint
 * returns the full company-official JD. Nothing to scrape in a browser.
 *
 *   node tools/waiqi-scan.mjs                     # 全量：列表→过滤→去重→拉JD→写 inbox/
 *   node tools/waiqi-scan.mjs --max-pages 30      # 列表请求上限 30 次（见下）
 *   node tools/waiqi-scan.mjs --since 2026-10-18  # 只看 updateTime >= 该日期的岗位
 *   node tools/waiqi-scan.mjs --categories IT技术,供应链  # 只扫指定职位类别（名，逗号分隔）
 *   node tools/waiqi-scan.mjs --dry-run           # 只统计，不写 inbox / scan-history
 *
 * 注意：foreign/page-list 的 page 参数已失效（page>=2 恒返回空），全量枚举改为
 * 「过滤分片」：按 职位类别(posIds) 切 60 片，任一切片返回满 PAGE_SIZE 条则递归细分
 * （先按 posIds 二分，再按 workExp 1..5），直到每片 <PAGE_SIZE 条。--max-pages 因此是
 * 列表请求次数上限，不再是页码上限。
 *
 * 过滤：tools/title-filter.mjs（portals.yml 的 track-scoped 规则，与 scan 模式同一套）。
 * 去重：scan-history.tsv URL + inbox/processed 已抓 id + applications.md 公司·岗位 + pipeline.md URL。
 * 节流：请求间隔 1000ms；失败重试 2 次，HTTP 429（限流）时退避 30s/60s/120s。
 * 详情接口配额低（~150 次/小时），大跑容易中途 429：中断后重跑即可续跑——已落盘的 JD
 * 有 history 记录不会重复拉；详情失败的岗位不入 scan-history，下次重跑自然重试。
 * 手动低频运行，只读公开数据。
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
const DELAY_MS = 1000;
const PAGE_SIZE = 50; // 实测 size<=50 正常返回，>=60 报 code 1010
const WORK_EXP_VALUES = ['1', '2', '3', '4', '5']; // 实测 6+ 恒返回空

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= tries) throw e;
      const waits = String(e.message).includes('429') ? [30000, 60000, 120000] : [1000, 2000];
      await sleep(waits[i - 1] || 2000);
    }
  }
}

// foreign/page-list 的 page 参数已失效（page>=2 恒返回空记录），只能按过滤条件
// 分片枚举：每片最多返回 PAGE_SIZE 条，返回满则说明可能截断，需继续细分。
async function listSlice({ posIds, workExp }) {
  const res = await fetch(`${API}/social-position/foreign/page-list`, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({
      expectId: 0, workExp, education: '', businessCategoryIdList: '',
      companyTypeList: [], sort: 0, type: 2, cityIds: '', posIds,
      status: 1, page: 1, size: PAGE_SIZE, needAd: 1,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} page-list slice`);
  const body = await res.json();
  if (body.code !== 1000) throw new Error(`page-list slice: code ${body.code} ${body.message || ''}`);
  return { records: body.data?.positionVO?.records || [], count: body.data?.count };
}

/** 职位类别 → 该类别的全部 posIds（来自 /position/pos-all-list）。 */
async function posCategories() {
  const res = await fetch(`${API}/position/pos-all-list`, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} pos-all-list`);
  const body = await res.json();
  if (body.code !== 1000) throw new Error(`pos-all-list: code ${body.code} ${body.message || ''}`);
  const byCat = new Map();
  for (const p of body.data || []) {
    if (p.name === '不限') continue;
    if (!byCat.has(p.categoryId)) byCat.set(p.categoryId, { name: p.categoryName, ids: [] });
    byCat.get(p.categoryId).ids.push(p.id);
  }
  return [...byCat.values()];
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
      const url = (cols[7] || '').match(/https?:\/\/[^\s|)\]]+/)?.[0];
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
      location: det.cityNamelist || det.cityNameList || rec.cityNameList || '',
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
const maxPages = opt('max-pages') ? Number(opt('max-pages')) : Infinity;
if (Number.isNaN(maxPages) || maxPages < 1) {
  console.error(`❌ --max-pages 需为 >=1 的数字，收到：${opt('max-pages')}`);
  process.exit(1);
}
const dryRun = argv.includes('--dry-run');
const since = opt('since') || null;
const categories = opt('categories')?.split(/[,，]/).map((s) => s.trim()).filter(Boolean) || null;

const filter = loadTitleFilter();
if (!filter) { console.error('❌ 找不到 portals.yml 或模板，无法加载 title_filter'); process.exit(1); }
if (filter.tracks.length === 0) { console.error('❌ title_filter.track_filters 缺失'); process.exit(1); }

// 1. 拉列表（过滤分片枚举：先按职位类别切片；满 PAGE_SIZE 条的片递归细分 —— 先二分
//    posIds，单片单 posId 仍满时再按 workExp 1..5 细分，仍满则记为截断）
const byId = new Map();
const truncated = [];
let listReqs = 0, failedSlices = 0;
const cats = await withRetry(posCategories).catch((e) => {
  console.error(`❌ 职位类别列表拉取失败：${e.message}（可能在限流中，稍后重试）`);
  process.exit(1);
});
const selected = categories ? cats.filter((c) => categories.includes(c.name)) : cats;
if (categories && selected.length === 0) {
  console.error(`❌ --categories 无匹配。可用类别：${cats.map((c) => c.name).join('、')}`);
  process.exit(1);
}
const queue = selected.map((c) => ({ posIds: c.ids.join(','), workExp: '', label: c.name }));
while (queue.length && listReqs < maxPages) {
  const slice = queue.shift();
  if (listReqs > 0) await sleep(DELAY_MS);
  listReqs++;
  if (listReqs % 25 === 0) console.log(`… 列表进度：${listReqs} 次请求，已收 ${byId.size} 条，队列余 ${queue.length}`);
  let recs, count;
  try {
    ({ records: recs, count } = await withRetry(() => listSlice(slice)));
  } catch (e) {
    failedSlices++;
    console.log(`⚠️ 切片拉取失败（${slice.label}：${e.message}），跳过`);
    continue;
  }
  for (const r of recs) if (r && r.id && r.name && r.companyName) byId.set(r.id, r);
  // count 是该过滤条件下的总数：已知总数 <= 已收条数则枚举完整，无需再细分
  if (recs.length >= PAGE_SIZE && (typeof count !== 'number' || count > recs.length)) {
    if (slice.posIds.includes(',')) {
      const ids = slice.posIds.split(',');
      const mid = Math.ceil(ids.length / 2);
      queue.push({ ...slice, posIds: ids.slice(0, mid).join(',') });
      queue.push({ ...slice, posIds: ids.slice(mid).join(',') });
    } else if (!slice.workExp) {
      for (const w of WORK_EXP_VALUES) queue.push({ ...slice, workExp: w });
    } else {
      truncated.push(slice);
    }
  }
}
const capped = queue.length > 0;
const unique = [...byId.values()];

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

// 5+6. 拉详情 + 落盘；落盘成功立即写 scan-history（中断时已抓的 JD 不丢记录）。
// 详情失败的岗位不写 history，下次重跑自然重试。
const appendHistory = (rec, status) => {
  if (dryRun) return;
  const url = jobUrl(rec.id);
  if (hist.has(url)) return;
  fs.appendFileSync(HISTORY, `${url}\t${today()}\twaiqi\t${(rec.name || '').replace(/\t/g, ' ')}\t${(rec.companyName || '').replace(/\t/g, ' ')}\t${status}\n`, 'utf8');
  hist.add(url);
};
const added = [], shortJd = [], detailFail = [];
for (const { rec, verdict } of kept) {
  await sleep(DELAY_MS);
  try {
    const det = await withRetry(() => detail(rec.id));
    const desc = (det.description || '').trim();
    if (desc.length < 100) shortJd.push(rec);
    if (!dryRun) {
      const file = saveToInbox(rec, det);
      appendHistory(rec, 'added');
      added.push({ file, rec, verdict });
    } else added.push({ file: '(dry-run)', rec, verdict });
  } catch (e) {
    detailFail.push({ rec, err: e.message });
  }
}

// 7. scan-history：added 已在详情循环里即时写入，这里只补 drop 两类
for (const { rec } of droppedTitle) appendHistory(rec, 'skipped_title_filter');
for (const rec of droppedDup) appendHistory(rec, 'skipped_dup');

// 8. 摘要
const trackStat = {};
for (const { verdict } of kept) for (const t of verdict.tracks) trackStat[t] = (trackStat[t] || 0) + 1;
console.log(`
神仙外企 waiqi-scan — ${today()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
拉取列表：${unique.length} 条（列表请求 ${listReqs} 次${maxPages !== Infinity ? `，--max-pages ${maxPages}` : ''}${failedSlices ? `，切片失败 ${failedSlices}` : ''}）
${capped ? '⚠️ 列表请求达上限，枚举未完整（增大 --max-pages 或不带该参数重跑）\n' : ''}${truncated.length ? `⚠️ ${truncated.length} 个最小切片仍满 ${PAGE_SIZE} 条，可能截断：${truncated.map((s) => s.label).join('、')}\n` : ''}${since ? `--since ${since} 后：${dated.length} 条\n` : ''}标题过滤 keep：${kept.length}（${Object.entries(trackStat).map(([t, n]) => `${t}: ${n}`).join(' · ') || '—'}）
标题过滤 drop：${droppedTitle.length}
去重跳过：${droppedDup.length}
拉详情失败：${detailFail.length}${shortJd.length ? `\n⚠️ JD 过短(<100字)：${shortJd.length}（已照常落盘，inbox triage 时留意）` : ''}
${dryRun ? '\n(dry-run，未写任何文件)' : `新写入 inbox/：${added.filter((a) => a.file !== '(dry-run)').length} 个 JSON
→ 回 Claude 跑 /career-ops inbox`}`);
if (dryRun || process.env.WAIQI_VERBOSE) {
  for (const { rec, verdict } of kept.slice(0, 50)) console.log(`  KEEP [${verdict.tracks.join('+')}] ${rec.companyName} | ${rec.name} | ${rec.cityNameList || ''}`);
}
if (detailFail.length) for (const { rec, err } of detailFail) console.log(`  ❌ ${rec.name}: ${err}`);
