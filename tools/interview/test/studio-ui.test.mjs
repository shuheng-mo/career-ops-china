import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..', '..', 'apps', 'interview-studio');

test('[S3.5] 静态文件齐全', () => {
  for (const f of ['index.html', 'app.js', 'style.css']) {
    assert.ok(existsJoin(f), `缺 ${f}`);
  }
});
function existsJoin(f) {
  try { readFileSync(join(APP, f)); return true; } catch { return false; }
}

test('[S3.5] app.js 语法合法', () => {
  execFileSync('node', ['--check', join(APP, 'app.js')], { encoding: 'utf8' });
});

test('[S3.5] 无 CDN / 无外链资源（CSP self 语义）', () => {
  const cdnRe = new RegExp('https?://(cdn|unpkg|jsdelivr|googleapis|cloudflare)');
  for (const f of ['index.html', 'app.js', 'style.css']) {
    const text = readFileSync(join(APP, f), 'utf8');
    assert.ok(!cdnRe.test(text), `${f} 疑似 CDN 引用`);
    assert.ok(!/src="http/.test(text), `${f} 有外链 script`);
    assert.ok(!/href="http/.test(text.replace(/https:\/\/example\.com/g, '')), `${f} 有外链 css`);
  }
});

test('[S3.5] 动态内容一律走 escapeHtml（XSS）', () => {
  const app = readFileSync(join(APP, 'app.js'), 'utf8');
  assert.ok(app.includes('function esc('), '缺少 escapeHtml');
  // 所有 innerHTML 赋值的模板串必须引用 esc(（静态模板不含变量插值 ${ 的除外）
  const lines = app.split('\n').filter((l) => l.includes('innerHTML') || l.includes('`${'));
  const dynamic = lines.filter((l) => /\$\{/.test(l) && l.includes('innerHTML'));
  for (const l of dynamic) {
    assert.ok(/esc\(/.test(l), `未转义的 innerHTML 赋值：${l.trim().slice(0, 120)}`);
  }
  assert.ok(dynamic.length >= 1, '应存在动态渲染点（自检）');
});

test('[S3.5] 无内联事件处理器（CSP script-src self）', () => {
  const html = readFileSync(join(APP, 'index.html'), 'utf8');
  assert.ok(!/on(click|load|change)=/.test(html), 'index.html 含内联事件');
});
