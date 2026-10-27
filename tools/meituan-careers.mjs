#!/usr/bin/env node
/**
 * meituan-careers.mjs — pull social-hire postings from zhaopin.meituan.com into inbox/.
 *
 * Same idea as tencent-careers.mjs: the careers site is a SPA over a public JSON API
 * (POST /api/official/job/getJobList), so listing is one request per page of 50.
 *
 *   npm run meituan -- agent --city 上海,深圳 [--days 30] [--fetch]
 *
 * Without --fetch it only lists (one line per posting, with its detail URL). With
 * --fetch every listed posting is written to inbox/ in the bookmarklet JSON format;
 * postings already in inbox/ or inbox/processed/ are skipped. The list response
 * already carries the full duty + requirement text, so --fetch needs no extra calls.
 *
 * `--days` filters on refreshTime (the API has no separate publish date). The city
 * filter is applied client-side on the posting's city names: the API's own city codes
 * are not documented and a multi-city posting lists every city it is open in.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INBOX = path.join(ROOT, 'inbox');
const API = 'https://zhaopin.meituan.com/api/official/job/getJobList';
const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  Origin: 'https://zhaopin.meituan.com',
  Referer: 'https://zhaopin.meituan.com/web/position',
};
const DELAY_MS = 1000;
const PAGE_SIZE = 50;
const SOCIAL_HIRE = '3';   // jobType code for 社招

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(keyword, pageNo) {
  const body = {
    page: { pageNo, pageSize: PAGE_SIZE }, jobShareType: '1', keywords: keyword,
    cityList: [], department: [], jfJgList: [], jobType: [{ code: SOCIAL_HIRE, subCode: [] }], typeCode: [], specialCode: [],
  };
  const res = await fetch(API, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.data) throw new Error(`unexpected response: ${JSON.stringify(json).slice(0, 200)}`);
  return json.data;
}

// Pages overlap — the same posting can come back on two pages — so collect by id.
async function listAll(keyword) {
  const posts = new Map();
  for (let n = 1; ; n++) {
    if (n > 1) await sleep(DELAY_MS);
    const data = await page(keyword, n);
    for (const p of data.list || []) posts.set(String(p.jobUnionId), p);
    if (!data.list?.length || n >= data.page.totalPage) return [...posts.values()];
  }
}

const jobUrl = (id) => `https://zhaopin.meituan.com/web/position/detail?jobUnionId=${id}&highlightType=social`;
const cities = (p) => (p.cityList || []).map((c) => String(c.name || '').replace(/市$/, ''));
const dept = (p) => p.department?.[0]?.name || '';
const ymd = (ms) => (ms ? new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '—');

/** jobUnionIds already captured, so a re-run only adds what is new. */
function capturedIds() {
  const ids = new Set();
  for (const dir of [INBOX, path.join(INBOX, 'processed')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const { url = '' } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const id = url.match(/zhaopin\.meituan\.com\/.*jobUnionId=(\d+)/)?.[1];
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

function saveToInbox(p) {
  const payload = {
    url: jobUrl(p.jobUnionId),
    page_title: `${p.name} - 美团招聘`,
    captured_at: new Date().toISOString(),
    platform: 'meituan-careers',
    capture_method: 'tools/meituan-careers.mjs (zhaopin.meituan.com API)',
    extracted: {
      job_title: p.name,
      company: '美团',
      salary: '',
      location: cities(p).join('/'),
      department: dept(p),
      description: `岗位职责\n${p.jobDuty || ''}\n\n任职要求\n${p.jobRequirement || ''}${p.highLight ? `\n\n职位亮点\n${p.highLight}` : ''}`,
      posted: ymd(p.refreshTime),
    },
  };
  fs.mkdirSync(INBOX, { recursive: true });
  let file = `jd-${timestamp()}-meituan-careers-${slugify(p.name)}.json`;
  for (let n = 2; fs.existsSync(path.join(INBOX, file)); n++) file = file.replace(/(-\d+)?\.json$/, `-${n}.json`);
  fs.writeFileSync(path.join(INBOX, file), JSON.stringify(payload, null, 2), 'utf8');
  return `inbox/${file}`;
}

function usage() {
  console.error(`用法:
  npm run meituan -- <关键词> [--city 上海,深圳] [--days 30] [--fetch]
  不加 --fetch 只列出；加了就把列出的岗位（含完整职责与要求）存进 inbox/，已抓过的自动跳过`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
};
const keyword = argv.find((a, i) => !a.startsWith('--') && !/^--(days|city)$/.test(argv[i - 1] || ''));
if (!keyword) usage();

const wantCities = (opt('city') || '').split(/[,，]/).map((c) => c.trim()).filter(Boolean);
const days = Number(opt('days') || 0);
const cutoff = days ? Date.now() - days * 86400000 : 0;

const all = await listAll(keyword);
const posts = all
  .filter((p) => !wantCities.length || cities(p).some((c) => wantCities.includes(c)))
  .filter((p) => !cutoff || (p.refreshTime || 0) >= cutoff)
  .sort((a, b) => (b.refreshTime || 0) - (a.refreshTime || 0));

console.log(`🔎 关键词「${keyword}」· 社招共 ${all.length} 条 · 符合城市${days ? `且近 ${days} 天更新` : ''} ${posts.length} 条\n`);

const seen = capturedIds();
for (const p of posts) {
  const mark = seen.has(String(p.jobUnionId)) ? '（已抓）' : '';
  console.log(`${ymd(p.refreshTime)} | ${cities(p).join('/')} | ${dept(p)} | ${p.name}${mark} | ${jobUrl(p.jobUnionId)}`);
}

if (!argv.includes('--fetch')) {
  if (posts.length) console.log(`\n加 --fetch 把这些存进 inbox/`);
  process.exit(0);
}

const todo = posts.filter((p) => !seen.has(String(p.jobUnionId)));
console.log(`\n📥 存入 ${todo.length} 条（跳过已抓 ${posts.length - todo.length} 条）`);
for (const p of todo) console.log(`  ${saveToInbox(p)}`);
