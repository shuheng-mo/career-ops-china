// 静态文件服务（路径安全 + MIME，无 CDN）
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function serveStatic(appDir, urlPath) {
  if (urlPath.includes('\0')) return { status: 400, body: 'bad path' };
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const target = resolve(appDir, rel);
  if (target !== resolve(appDir) && !target.startsWith(resolve(appDir) + sep)) {
    return { status: 400, body: 'path escapes app dir' };
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    return { status: 404, body: 'not found' };
  }
  const mime = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
  return { status: 200, body: readFileSync(target), contentType: mime };
}
