#!/usr/bin/env node
/**
 * tencent-careers.mjs — pull postings from careers.tencent.com into inbox/.
 *
 * The careers site is a SPA over a public JSON API, so there is nothing to
 * scrape: the search page's own filters map 1:1 onto query parameters.
 *
 *   npm run tencent -- "<careers.tencent.com/search.html?... URL>" [--days 30] [--fetch]
 *   npm run tencent -- agent --city 上海,深圳 [--days 30] [--fetch]
 *
 * Without --fetch it only lists. With --fetch every listed posting (full
 * responsibilities + requirements) is written to inbox/ in the bookmarklet
 * JSON format; postings already in inbox/ or inbox/processed/ are skipped.
 *
 * `--days` filters on LastUpdateTime — the API exposes no separate publish
 * date, and a refreshed posting is as live as a new one.
 *
 * One request at a time, ~1s apart. This is Tencent's own careers site, the
 * channel modes/scan.md prefers over the job boards.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INBOX = path.join(ROOT, 'inbox');
const API = 'https://careers.tencent.com/tencentcareer/api/post';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  Referer: 'https://careers.tencent.com/search.html',
};
const DELAY_MS = 1000;
const PAGE_SIZE = 100;

// cityId values as used by the site's `ci_` filter tokens.
const CITIES = { 深圳: 1, 北京: 2, 上海: 3, 广州: 5, 杭州: 7, 西安: 9 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(endpoint, params) {
  const qs = new URLSearchParams({ timestamp: String(Date.now()), language: 'zh-cn', area: 'cn', ...params });
  const res = await fetch(`${API}/${endpoint}?${qs}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${endpoint}`);
  const body = await res.json();
  if (body.Code !== 200) throw new Error(`${endpoint}: Code ${body.Code}`);
  return body.Data;
}

/** Turn a search.html URL (or a bare keyword + --city) into Query params. */
function filtersFrom(arg, cityOpt) {
  const filters = { keyword: '', cityId: '', categoryId: '', bgIds: '', productId: '' };
  if (/^https?:\/\/careers\.tencent\.com\//.test(arg)) {
    const u = new URL(arg);
    filters.keyword = u.searchParams.get('keyword') || '';
    const tokens = (u.searchParams.get('query') || '').split(',').filter(Boolean);
    const take = (prefix) => tokens.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length)).join(',');
    filters.categoryId = take('ot_');
    filters.cityId = take('ci_');
    filters.bgIds = take('bg_');
    filters.productId = take('pi_');
  } else {
    filters.keyword = arg;
  }
  if (cityOpt) {
    filters.cityId = cityOpt.split(/[,，]/).map((c) => {
      const id = CITIES[c.trim()] ?? (/^\d+$/.test(c.trim()) ? Number(c) : null);
      if (id == null) throw new Error(`不认识的城市：${c}（可用：${Object.keys(CITIES).join(' ')}，或直接写 cityId 数字）`);
      return id;
    }).join(',');
  }
  return filters;
}

async function listAll(filters) {
  const posts = [];
  for (let page = 1; ; page++) {
    if (page > 1) await sleep(DELAY_MS);
    const data = await api('Query', { ...filters, pageIndex: String(page), pageSize: String(PAGE_SIZE) });
    posts.push(...(data.Posts || []));
    if (!data.Posts?.length || posts.length >= data.Count) return posts;
  }
}

/** "2026年09月14日" → Date (Beijing midnight). */
function parseDate(s) {
  const m = String(s).match(/(\d{4})年(\d{2})月(\d{2})日/);
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`) : null;
}

const jobUrl = (postId) => `https://careers.tencent.com/jobdesc.html?postId=${postId}`;

/** postIds already captured, so a re-run only adds what is new. */
function capturedIds() {
  const ids = new Set();
  for (const dir of [INBOX, path.join(INBOX, 'processed')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const { url = '' } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const id = url.match(/careers\.tencent\.com\/jobdesc\.html\?postId=(\d+)/)?.[1];
        if (id) ids.add(id);
      } catch {}
    }
  }
  return ids;
}

// Same conventions as tools/jd-inbox-server.mjs; timestamp pinned to Beijing time.
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

function saveToInbox(d) {
  const company = ['腾讯', d.BGName, d.ProductName].filter(Boolean).join(' · ');
  const payload = {
    url: jobUrl(d.PostId),
    page_title: `${d.RecruitPostName} - ${company} - 腾讯招聘`,
    captured_at: new Date().toISOString(),
    platform: 'tencent-careers',
    capture_method: 'tools/tencent-careers.mjs (careers.tencent.com API)',
    extracted: {
      job_title: d.RecruitPostName,
      company,
      salary: '',
      location: d.LocationName,
      seniority_experience: d.RequireWorkYearsName || '',
      description: `岗位职责\n${(d.Responsibility || '').replace(/\r/g, '')}\n\n任职要求\n${(d.Requirement || '').replace(/\r/g, '')}`,
      requirements: [d.CategoryName, d.RequireWorkYearsName].filter(Boolean).join('；'),
      posted: d.LastUpdateTime,
      team_intro: (d.Introduction || '').replace(/\r/g, ''),
    },
  };
  fs.mkdirSync(INBOX, { recursive: true });
  let file = `jd-${timestamp()}-tencent-careers-${slugify(d.RecruitPostName)}.json`;
  for (let n = 2; fs.existsSync(path.join(INBOX, file)); n++) file = file.replace(/(-\d+)?\.json$/, `-${n}.json`);
  fs.writeFileSync(path.join(INBOX, file), JSON.stringify(payload, null, 2), 'utf8');
  return `inbox/${file}`;
}

function usage() {
  console.error(`用法:
  npm run tencent -- "<careers.tencent.com/search.html?... 链接>" [--days 30] [--fetch]
  npm run tencent -- <关键词> [--city 上海,深圳] [--days 30] [--fetch]
  不加 --fetch 只列出；加了就把列出的岗位（含完整职责与要求）存进 inbox/，已抓过的自动跳过
  城市：${Object.keys(CITIES).join(' ')}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
};
const target = argv.find((a, i) => !a.startsWith('--') && !/^--(days|city)$/.test(argv[i - 1] || ''));
if (!target) usage();

const filters = filtersFrom(target, opt('city'));
const days = Number(opt('days') || 0);
const cutoff = days ? new Date(Date.now() - days * 86400000) : null;

const all = await listAll(filters);
const posts = all
  .filter((p) => !cutoff || (parseDate(p.LastUpdateTime) ?? 0) >= cutoff)
  .sort((a, b) => (parseDate(b.LastUpdateTime) ?? 0) - (parseDate(a.LastUpdateTime) ?? 0));

const byCity = posts.reduce((m, p) => ((m[p.LocationName] = (m[p.LocationName] || 0) + 1), m), {});
console.log(`🔎 关键词「${filters.keyword || '（无）'}」· 共 ${all.length} 条${days ? ` · 近 ${days} 天更新 ${posts.length} 条` : ''}`);
console.log(`   城市分布：${Object.entries(byCity).map(([c, n]) => `${c} ${n}`).join(' · ') || '—'}\n`);

const seen = capturedIds();
for (const p of posts) {
  const mark = seen.has(String(p.PostId)) ? '（已抓）' : '';
  console.log(`${p.LastUpdateTime} | ${p.LocationName} | ${p.BGName} | ${p.RecruitPostName}${mark} | ${jobUrl(p.PostId)}`);
}

if (!argv.includes('--fetch')) {
  if (posts.length) console.log(`\n加 --fetch 把这些存进 inbox/`);
  process.exit(0);
}

const todo = posts.filter((p) => !seen.has(String(p.PostId)));
console.log(`\n📥 抓取 ${todo.length} 条（跳过已抓 ${posts.length - todo.length} 条）`);
let ok = 0;
for (const p of todo) {
  await sleep(DELAY_MS);
  try {
    const d = await api('ByPostId', { postId: String(p.PostId) });
    saveToInbox(d);
    ok++;
  } catch (e) {
    console.log(`❌ ${p.RecruitPostName}: ${e.message}`);
  }
}
console.log(`✅ ${ok} 条已存进 inbox/，回到 Claude 跑 /career-ops inbox`);
