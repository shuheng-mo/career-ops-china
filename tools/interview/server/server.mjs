// Interview Studio 本地 server（spec §8/§10）：
// 只监听 127.0.0.1；随机启动 token；Origin/Host 校验；CSP self；
// 静态资源零 CDN；JSON API 薄封装 core 层（路由在各 task 中追加）。
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from './static.mjs';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'interview-studio');

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// API 路由表：由各 task 以 registerApi(server) 形式扩展；这里先建骨架
const apiHandlers = [];
export function registerApi(handler) {
  apiHandlers.push(handler);
}

export function randomToken() {
  return randomBytes(16).toString('hex');
}

export function createStudioServer(root, { port = 8790, token = randomToken(), host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    // Host 必须是 127.0.0.1(:port)
    const hostHeader = (req.headers.host || '').split(':')[0];
    if (hostHeader !== '127.0.0.1' && hostHeader !== 'localhost') {
      return json(res, 403, { ok: false, message: '非本机 Host，已拒绝' });
    }
    // Origin 出现时必须是同源（本服务自身）——校验先于 token，避免把跨源探测误当认证问题
    const origin = req.headers.origin;
    if (origin && !origin.startsWith(`http://127.0.0.1:${port}`) && origin !== `http://127.0.0.1:${port}`) {
      return json(res, 403, { ok: false, message: '跨源请求已拒绝' });
    }
    // token：查询参数或 X-Studio-Token 头
    const supplied = url.searchParams.get('token') || req.headers['x-studio-token'];
    if (supplied !== token) {
      return json(res, 401, { ok: false, message: 'token 缺失或不正确（以启动时终端打印的为准）' });
    }

    // API 路由
    if (url.pathname.startsWith('/api/')) {
      for (const handler of apiHandlers) {
        const handled = await handler({ req, res, url, root, token });
        if (handled) return;
      }
      return json(res, 404, { ok: false, message: `未知 API：${url.pathname}` });
    }

    // 静态资源
    const r = serveStatic(APP_DIR, url.pathname);
    if (r.status === 200) {
      res.writeHead(200, {
        'Content-Type': r.contentType,
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      res.end(r.body);
    } else {
      res.writeHead(r.status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(r.body);
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}
