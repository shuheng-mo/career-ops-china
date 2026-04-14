#!/usr/bin/env node
// JD Inbox Server — receives JD payloads from browser bookmarklets and
// writes them to inbox/ for Claude to process via /career-ops inbox.
//
// Usage:
//   node tools/jd-inbox-server.mjs [--port 8787]
//
// Endpoints:
//   POST /jd       — accepts JSON body (see schema in tools/bookmarklets/*)
//   GET  /health   — returns "ok"
//
// CORS is open (Allow-Origin: *) so bookmarklets running on any site can POST.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const PORT = Number(process.argv.find(a => a.startsWith('--port='))?.split('=')[1]) || 8787;
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const INBOX = path.join(ROOT, 'inbox');

if (!fs.existsSync(INBOX)) fs.mkdirSync(INBOX, { recursive: true });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function slugify(s, max = 40) {
  if (!s) return 'unknown';
  return s
    .replace(/[\/\\<>:"|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, max)
    .trim() || 'unknown';
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (req.method === 'POST' && req.url === '/jd') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 5_000_000) req.destroy(); });
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
      }

      const platform = payload.platform || 'universal';
      const titleHint = payload.extracted?.job_title || payload.extracted?.company || payload.page_title || 'unknown';
      const filename = `jd-${timestamp()}-${platform}-${slugify(titleHint)}.json`;
      const filepath = path.join(INBOX, filename);

      fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf8');

      console.log(`[${new Date().toISOString()}] saved ${filename}`);
      console.log(`  platform: ${platform}`);
      console.log(`  url: ${payload.url}`);
      console.log(`  title hint: ${titleHint}`);
      console.log(`  raw_text length: ${payload.extracted?.raw_text?.length || 0}`);

      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, file: `inbox/${filename}` }));
    });
    return;
  }

  res.writeHead(404, { ...CORS, 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`JD Inbox Server listening on http://localhost:${PORT}`);
  console.log(`  POST /jd   → writes to ${INBOX}/`);
  console.log(`  GET /health → ok`);
  console.log(`Open tools/install.html in your browser, drag bookmarklets to bookmarks bar, click them on any JD page.`);
});
