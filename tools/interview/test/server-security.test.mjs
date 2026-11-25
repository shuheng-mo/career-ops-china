import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudioServer } from '../server/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function fetchWithClose(url, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(u, { method: init.method || 'GET', headers: init.headers || {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(root, opts, fn) {
  const srv = await createStudioServer(root, opts);
  try {
    return await fn(srv);
  } finally {
    srv.closeAllConnections();
    await new Promise((res) => srv.close(res));
  }
}

function preparedRoot() {
  const t = mkdtempSync(join(tmpdir(), 'ib-srv-'));
  const appDir = join(HERE, '..', '..', '..', 'apps', 'interview-studio');
  mkdirSync(appDir, { recursive: true });
  return t;
}

test('[S3.1] 无 token 401、错 token 401、正确 token 200 拿到 index', async () => {
  const t = preparedRoot();
  await withServer(t, { port: 0, token: 'tok123' }, async (srv) => {
    const port = srv.address().port;
    const base = `http://127.0.0.1:${port}`;
    const r401 = await fetchWithClose(`${base}/`);
    assert.equal(r401.status, 401);
    const r401b = await fetchWithClose(`${base}/?token=wrong`);
    assert.equal(r401b.status, 401);
    const ok = await fetchWithClose(`${base}/?token=tok123`);
    assert.equal(ok.status, 200);
    assert.match(ok.text, /studio/i);
    const csp = ok.headers['content-security-policy'];
    assert.ok(csp && csp.includes("default-src 'self'"), `CSP: ${csp}`);
  });
});

test('[S3.1] 伪造 Origin / 非本机 Host → 403', async () => {
  const t = preparedRoot();
  await withServer(t, { port: 0, token: 'tok' }, async (srv) => {
    const port = srv.address().port;
    const base = `http://127.0.0.1:${port}`;
    const rOrigin = await fetchWithClose(`${base}/api/blocks?token=tok`, { headers: { Origin: 'https://evil.com' } });
    assert.equal(rOrigin.status, 403);
    // undici fetch 禁止自定义 Host 头 → 用原生 http.request 模拟伪造 Host
    const rHost = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/?token=tok', headers: { Host: 'evil.com' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.end();
    });
    assert.equal(rHost, 403);
  });
});

test('[S3.1] 静态路径穿越 → 400', async () => {
  const t = preparedRoot();
  await withServer(t, { port: 0, token: 'tok' }, async (srv) => {
    const port = srv.address().port;
    const r = await fetchWithClose(`http://127.0.0.1:${port}/static/../../etc/passwd?token=tok`);
    assert.ok(r.status === 400 || r.status === 404, `实际 ${r.status}`);
    assert.ok(!r.text.includes('root:'), '不得泄漏 passwd 内容');
  });
});

test('[S3.C1] 畸形百分号编码 → 400/404，server 存活（不打崩进程）', async () => {
  const t = preparedRoot();
  await withServer(t, { port: 0, token: 'tok' }, async (srv) => {
    const port = srv.address().port;
    const r1 = await fetchWithClose(`http://127.0.0.1:${port}/%?token=tok`);
    assert.ok([400, 404].includes(r1.status), `畸形编码实际 ${r1.status}`);
    // server 还活着：后续正常请求可用
    const r2 = await fetchWithClose(`http://127.0.0.1:${port}/?token=tok`);
    assert.equal(r2.status, 200);
  });
});

test('[S3.I5] Origin localhost 拼写与端口精确匹配；前缀仿冒 403', async () => {
  const t = preparedRoot();
  await withServer(t, { port: 0, token: 'tok' }, async (srv) => {
    const port = srv.address().port;
    const rLocal = await fetchWithClose(`http://127.0.0.1:${port}/api/blocks?token=tok`, { headers: { Origin: `http://localhost:${port}` } });
    assert.equal(rLocal.status, 200, `localhost 同源应放行，实际 ${rLocal.status}`);
    const rEvil = await fetchWithClose(`http://127.0.0.1:${port}/api/blocks?token=tok`, { headers: { Origin: `http://127.0.0.1:${port}evil.com` } });
    assert.equal(rEvil.status, 403, '前缀仿冒 Origin 必须 403');
  });
});

test('[S3.6] 首访 query token 种 cookie；子资源凭 cookie 加载（浏览器真实链路）', async () => {
  const t = preparedRoot();
  await withServer(t, { port: 0, token: 'tok123' }, async (srv) => {
    const port = srv.address().port;
    const base = `http://127.0.0.1:${port}`;
    // 1. 带 token 打开 HTML → 200 + 种 HttpOnly/SameSite=Strict cookie
    const html = await fetchWithClose(`${base}/?token=tok123`);
    assert.equal(html.status, 200);
    const setCookie = html.headers['set-cookie'];
    assert.ok(setCookie && setCookie.length > 0, '首访应种 Set-Cookie');
    assert.match(setCookie[0], /studio-token=tok123/);
    assert.match(setCookie[0], /HttpOnly/i);
    assert.match(setCookie[0], /SameSite=Strict/i);
    // 2. 子资源（script/link 标签不带 query token）凭 cookie → 200
    const cookie = setCookie[0].split(';')[0];
    const js = await fetchWithClose(`${base}/app.js`, { headers: { Cookie: cookie } });
    assert.equal(js.status, 200, 'app.js 凭 cookie 应可加载');
    assert.match(js.headers['content-type'] || '', /javascript/);
    const css = await fetchWithClose(`${base}/style.css`, { headers: { Cookie: cookie } });
    assert.equal(css.status, 200, 'style.css 凭 cookie 应可加载');
    const worklet = await fetchWithClose(`${base}/worklet.js`, { headers: { Cookie: cookie } });
    assert.equal(worklet.status, 200, 'worklet.js 凭 cookie 应可加载');
    // 3. 错 cookie / 无凭据仍 401（子资源不公开豁免）
    const bad = await fetchWithClose(`${base}/app.js`, { headers: { Cookie: 'studio-token=wrong' } });
    assert.equal(bad.status, 401);
    const none = await fetchWithClose(`${base}/app.js`);
    assert.equal(none.status, 401);
  });
});
