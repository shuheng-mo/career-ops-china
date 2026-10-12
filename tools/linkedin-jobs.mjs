#!/usr/bin/env node
/**
 * linkedin-jobs.mjs — LinkedIn China job postings without logging in.
 *
 * cn.linkedin.com job pages fold the description behind a sign-in wall, so the
 * bookmarklets capture little or nothing there. LinkedIn's own logged-out
 * endpoints (`jobs-guest/...`) return the full posting as plain HTML, which is
 * what this reads.
 *
 *   npm run linkedin -- <job url | job id> [...]
 *       Fetch each posting into inbox/ in the bookmarklet JSON format, so
 *       /career-ops inbox evaluates it like any other capture.
 *
 *   npm run linkedin -- search "<keywords>" [--city 上海] [--days 7] [--pages 2] [--fetch]
 *       List matching postings (id, title, company, city, age). --fetch also
 *       saves every listed posting into inbox/.
 *
 * Kept deliberately low-volume: one request at a time, ~1.5s apart, at most
 * 5 result pages per search. This is for reading postings you would otherwise
 * open by hand, not for crawling.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INBOX = path.join(ROOT, 'inbox');
const GUEST = 'https://www.linkedin.com/jobs-guest/jobs/api';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
const DELAY_MS = 1500;
const MAX_PAGES = 5;

// The search endpoint only understands English place names; a bare Chinese
// city name silently falls back to worldwide results.
const CITIES = {
  中国: 'China',
  上海: 'Shanghai, China',
  北京: 'Beijing, China',
  苏州: 'Suzhou, Jiangsu, China',
  杭州: 'Hangzhou, Zhejiang, China',
  南京: 'Nanjing, Jiangsu, China',
  无锡: 'Wuxi, Jiangsu, China',
  常州: 'Changzhou, Jiangsu, China',
  合肥: 'Hefei, Anhui, China',
  宁波: 'Ningbo, Zhejiang, China',
  深圳: 'Shenzhen, Guangdong, China',
  广州: 'Guangzhou, Guangdong, China',
  武汉: 'Wuhan, Hubei, China',
  成都: 'Chengdu, Sichuan, China',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
    if (res.status === 429) {           // rate limited: back off, don't hammer
      await sleep(10000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.text();
  }
  throw new Error(`HTTP 429 (rate limited) ${url}`);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z#0-9]+);/gi, (m, n) => ENTITIES[n] ?? m);
}

/** Inner text of the first match, with block tags turned into newlines. */
function pick(html, re) {
  const m = html.match(re);
  if (!m) return '';
  return decode(
    m[1]
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|ul|ol|div|h\d)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function jobIdOf(arg) {
  const m = String(arg).match(/(\d{9,})/);
  if (!m) throw new Error(`认不出岗位 ID：${arg}（要 /jobs/view/… 链接或纯数字 ID；搜索页链接不行）`);
  return m[1];
}

async function fetchPosting(id) {
  const html = await get(`${GUEST}/jobPosting/${id}`);
  const title = pick(html, /<h2[^>]*top-card-layout__title[^>]*>([\s\S]*?)<\/h2>/);
  if (!title) throw new Error(`#${id} 没取到岗位（可能已下线）`);
  const criteria = [...html.matchAll(
    /description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>[\s\S]*?description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/g,
  )].map((m) => `${decode(m[1]).trim()}: ${decode(m[2]).trim()}`);
  return {
    id,
    title,
    company: pick(html, /topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/)
      || pick(html, /topcard__flavor[^>]*>([\s\S]*?)<\/span>/),
    location: pick(html, /topcard__flavor--bullet[^>]*>([\s\S]*?)<\/span>/),
    posted: pick(html, /posted-time-ago__text[^>]*>([\s\S]*?)<\/span>/),
    applicants: pick(html, /num-applicants__caption[^>]*>([\s\S]*?)<\/(?:span|figcaption)>/),
    criteria,
    description: pick(html, /show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/),
    closed: /closed-job__flavor--closed|No longer accepting applications|已停止接受求职申请|不再接受申请/.test(html),
  };
}

// Same conventions as tools/jd-inbox-server.mjs so inbox sorting and dedup
// treat these exactly like bookmarklet captures. Timestamp is pinned to
// Beijing time: the server runs in the user's terminal, this may not.
function slugify(s, max = 40) {
  if (!s) return 'unknown';
  return s.replace(/[\/\\<>:"|?*\x00-\x1f]/g, '').replace(/\s+/g, '-').slice(0, max).trim() || 'unknown';
}
function timestamp() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}

function saveToInbox(job, url) {
  const payload = {
    url: url || `https://cn.linkedin.com/jobs/view/${job.id}`,
    page_title: `${job.title} - ${job.company} - LinkedIn`,
    captured_at: new Date().toISOString(),
    platform: 'linkedin',
    capture_method: 'tools/linkedin-jobs.mjs (jobs-guest API)',
    extracted: {
      job_title: job.title,
      company: job.company,
      salary: '',
      location: job.location,
      description: job.description,
      requirements: job.criteria.join('；'),
      posted: job.posted,
      applicants: job.applicants,
      closed: job.closed,
    },
  };
  fs.mkdirSync(INBOX, { recursive: true });
  let file = `jd-${timestamp()}-linkedin-${slugify(job.company)}.json`;
  for (let n = 2; fs.existsSync(path.join(INBOX, file)); n++) {
    file = file.replace(/(-\d+)?\.json$/, `-${n}.json`);
  }
  fs.writeFileSync(path.join(INBOX, file), JSON.stringify(payload, null, 2), 'utf8');
  return `inbox/${file}`;
}

function report(job, file) {
  const flags = [job.closed && '⛔ 已停止招聘', /来源于猎聘|来源于前程无忧|来源于智联/.test(job.description) && '↪ 转载自其他招聘站'];
  console.log(`✅ ${job.title} | ${job.company} | ${job.location} | ${job.posted}${job.applicants ? ` | ${job.applicants}` : ''}`);
  for (const f of flags.filter(Boolean)) console.log(`   ${f}`);
  console.log(`   → ${file}（JD ${job.description.length} 字）`);
}

async function search(keywords, { city, days, pages, fetchAll }) {
  const params = new URLSearchParams({ keywords, location: CITIES[city] ?? (city ? `${city}, China` : 'China') });
  if (days) params.set('f_TPR', `r${days * 86400}`);
  const seen = new Map();
  for (let p = 0; p < Math.min(pages, MAX_PAGES); p++) {
    if (p) await sleep(DELAY_MS);
    params.set('start', String(p * 10));
    const html = await get(`${GUEST}/seeMoreJobPostings/search?${params}`);
    const cards = html.split(/<li>/).slice(1);
    if (!cards.length) break;
    for (const c of cards) {
      const id = c.match(/jobPosting:(\d+)/)?.[1];
      if (!id || seen.has(id)) continue;
      seen.set(id, {
        id,
        title: pick(c, /base-search-card__title[^>]*>([\s\S]*?)<\/h3>/),
        company: pick(c, /base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/),
        location: pick(c, /job-search-card__location[^>]*>([\s\S]*?)<\/span>/),
        posted: pick(c, /<time[^>]*>([\s\S]*?)<\/time>/),
      });
    }
  }
  const rows = [...seen.values()];
  console.log(`🔎 「${keywords}」· ${params.get('location')}${days ? ` · 近 ${days} 天` : ''} · ${rows.length} 条\n`);
  for (const r of rows) console.log(`${r.id} | ${r.title} | ${r.company} | ${r.location} | ${r.posted}`);
  if (!fetchAll || !rows.length) {
    if (rows.length) console.log(`\n要存进 inbox：npm run linkedin -- <id> [<id> ...]`);
    return;
  }
  console.log('');
  for (const r of rows) {
    await sleep(DELAY_MS);
    try {
      const job = await fetchPosting(r.id);
      report(job, saveToInbox(job));
    } catch (e) {
      console.log(`❌ ${e.message}`);
    }
  }
}

function usage() {
  console.error(`用法:
  npm run linkedin -- <岗位链接或 ID> [...]                 取 JD 存进 inbox/
  npm run linkedin -- search "关键词" [--city 上海] [--days 7] [--pages 2] [--fetch]
                                                            搜索；--fetch 把结果全部存进 inbox/
  城市可用：${Object.keys(CITIES).join(' ')}（其他城市按拼音写，如 --city Jiaxing）`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (!argv.length) usage();

if (argv[0] === 'search') {
  const opt = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i > -1 ? argv[i + 1] : def;
  };
  const keywords = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.match(/^--(city|days|pages)$/)).join(' ');
  if (!keywords) usage();
  await search(keywords, {
    city: opt('city'),
    days: Number(opt('days', 0)) || 0,
    pages: Number(opt('pages', 1)) || 1,
    fetchAll: argv.includes('--fetch'),
  });
} else {
  let failed = 0;
  for (const [i, arg] of argv.entries()) {
    if (i) await sleep(DELAY_MS);
    try {
      const job = await fetchPosting(jobIdOf(arg));
      report(job, saveToInbox(job, /^https?:/.test(arg) ? arg : undefined));
    } catch (e) {
      failed++;
      console.log(`❌ ${e.message}`);
    }
  }
  if (failed) process.exit(1);
}
