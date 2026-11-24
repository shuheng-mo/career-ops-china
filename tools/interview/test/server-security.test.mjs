import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createStudioServer } from '../server/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function preparedRoot() {
  const t = mkdtempSync(join(tmpdir(), 'ib-srv-'));
  const appDir = join(HERE, '..', '..', '..', 'apps', 'interview-studio');
  mkdirSync(appDir, { recursive: true });
  if (!existsSync(join(appDir, 'index.html'))) {
    writeFileSync(join(appDir, 'index.html'), '<!doctype html><html><body>studio</body></html>');
  }
  return t;
}
function existsSyncQuiet(p) { return existsSync(p); }

test('[S3.1] 无 token 401、错 token 401、正确 token 200 拿到 index', async () => {
  const t = preparedRoot();
  const srv = await createStudioServer(t, { port: 0, token: 'tok123' });
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  const r401 = await fetch(base);
  assert.equal(r401.status, 401);
  const r401b = await fetch(`${base}/?token=wrong`);
  assert.equal(r401b.status, 401);
  const ok = await fetch(`${base}/?token=tok123`);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /studio/);
  const csp = ok.headers.get('content-security-policy');
  assert.ok(csp && csp.includes("default-src 'self'"), `CSP: ${csp}`);
  srv.closeAllConnections();
  await new Promise((res) => srv.close(res));
});

test('[S3.1] 伪造 Origin / 非本机 Host → 403', async () => {
  const t = preparedRoot();
  const srv = await createStudioServer(t, { port: 0, token: 'tok' });
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  const rOrigin = await fetch(`${base}/api/blocks?token=tok`, { headers: { Origin: 'https://evil.com' } });
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
  srv.closeAllConnections();
  await new Promise((res) => srv.close(res));
});

test('[S3.1] 静态路径穿越 → 400', async () => {
  const t = preparedRoot();
  const srv = await createStudioServer(t, { port: 0, token: 'tok' });
  const port = srv.address().port;
  const r = await fetch(`http://127.0.0.1:${port}/static/../../etc/passwd?token=tok`);
  assert.ok(r.status === 400 || r.status === 404, `实际 ${r.status}`);
  const body = await r.text();
  assert.ok(!body.includes('root:'), '不得泄漏 passwd 内容');
  srv.closeAllConnections();
  await new Promise((res) => srv.close(res));
});
