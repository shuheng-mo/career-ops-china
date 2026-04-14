#!/usr/bin/env node
// Reads tools/bookmarklets/*.js, encodes each as a javascript: URL,
// generates tools/install.html with draggable links + source preview.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SRC_DIR = path.join(HERE, 'bookmarklets');
const OUT = path.join(HERE, 'install.html');

const META = {
  'universal.js': {
    label: '🌐 JD Capture (通用)',
    desc: '适用 80% 站点（V2EX / GitHub / 公司自有 careers / 多数 SPA）。先试这个。',
    color: '#3b82f6',
  },
  'boss-zhipin.js': {
    label: '💼 Boss 直聘',
    desc: 'Boss 反复制 + 反爬专用。Boss 详情页必用。',
    color: '#06b6d4',
  },
  'liepin.js': {
    label: '🎯 猎聘',
    desc: '猎聘详情页（liepin.com）。需先登录。',
    color: '#10b981',
  },
  'lagou.js': {
    label: '🛒 拉勾',
    desc: '拉勾详情页（lagou.com）。需先登录。',
    color: '#f59e0b',
  },
  'mokahr.js': {
    label: '🔑 Mokahr ATS',
    desc: 'DeepSeek 等独角兽用的 Mokahr ATS。如是 iframe 嵌入需先单开 iframe 链接。',
    color: '#8b5cf6',
  },
  'dachang-spa.js': {
    label: '🏢 大厂 Careers SPA',
    desc: '字节 / 阿里 / 蚂蚁 / 腾讯 / 美团 / 快手 / 小红书 / B站 / 网易 / 京东 / 拼多多 / 百度 / 滴滴 等 careers SPA。',
    color: '#ec4899',
  },
};

const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js')).sort();

const encode = (src) => {
  // Strip leading comment block + trim
  const stripped = src.replace(/^\/\/.*$/gm, '').trim();
  // Wrap in IIFE only if not already; our files are all already async IIFEs
  return 'javascript:' + encodeURIComponent(stripped);
};

const cards = files
  .map((f) => {
    const meta = META[f] || { label: f, desc: '', color: '#6b7280' };
    const src = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    const encoded = encode(src);
    return `
  <div class="card" style="border-left-color:${meta.color}">
    <div class="card-head">
      <a class="bm" href="${encoded}" style="background:${meta.color}">${meta.label}</a>
      <div class="meta">
        <code>${f}</code>
        <span class="size">${(encoded.length / 1024).toFixed(1)} KB</span>
      </div>
    </div>
    <p class="desc">${meta.desc}</p>
    <details>
      <summary>查看源码</summary>
      <pre><code>${escapeHtml(src)}</code></pre>
    </details>
  </div>`;
  })
  .join('\n');

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <title>career-ops bookmarklets — 安装</title>
  <style>
    body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
           max-width: 820px; margin: 2rem auto; padding: 1rem; color: #111; line-height: 1.6; }
    h1 { font-size: 1.6rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.2rem; margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; }
    .lead { color: #555; font-size: 0.95rem; }
    .steps { background: #f7f7f9; padding: 1rem 1.5rem; border-radius: 8px; margin: 1rem 0 2rem; }
    .steps ol { padding-left: 1.2rem; }
    .steps code { background: #fff; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; color: #c7254e; }
    .card { border: 1px solid #e5e7eb; border-left-width: 4px; border-radius: 6px;
            padding: 1rem; margin: 1rem 0; background: #fff; }
    .card-head { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
    .bm { display: inline-block; padding: 0.55rem 1rem; color: #fff; text-decoration: none;
          border-radius: 6px; font-weight: 600; cursor: grab; user-select: none; }
    .bm:active { cursor: grabbing; }
    .meta { color: #666; font-size: 0.85em; }
    .meta code { background: #f3f4f6; padding: 1px 5px; border-radius: 3px; }
    .size { margin-left: 0.6rem; opacity: 0.7; }
    .desc { margin: 0.5rem 0; color: #444; font-size: 0.95em; }
    details { margin-top: 0.5rem; }
    details summary { cursor: pointer; color: #3b82f6; font-size: 0.85em; }
    pre { background: #1f2937; color: #e5e7eb; padding: 1rem; border-radius: 6px;
          overflow-x: auto; font-size: 0.8em; margin-top: 0.5rem; }
    .footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e5e7eb;
              color: #888; font-size: 0.85em; }
  </style>
</head>
<body>
  <h1>career-ops 浏览器 bookmarklets — 安装</h1>
  <p class="lead">把下面的彩色按钮 <strong>拖到浏览器书签栏</strong>，然后在任意 JD 页面点一下，JD 就会自动发到本地 inbox 让 Claude 处理。</p>

  <div class="steps">
    <h3 style="margin-top:0">使用步骤</h3>
    <ol>
      <li>显示书签栏：Chrome / Edge <code>⌘+Shift+B</code>，Safari <code>⌘+Shift+B</code></li>
      <li>启动本地 inbox 服务器：终端跑 <code>npm run inbox-server</code> 或 <code>node tools/jd-inbox-server.mjs</code></li>
      <li>把下面想用的按钮 <strong>拖</strong> 到书签栏</li>
      <li>打开任意 JD 页面，点对应的 bookmarklet</li>
      <li>看到 ✓ 提示后，回到 Claude 跑 <code>/career-ops inbox</code> 处理</li>
    </ol>
  </div>

  <h2>可用 bookmarklets</h2>
${cards}

  <div class="footer">
    <p>生成时间：${new Date().toISOString()}　|　总数：${files.length} 个</p>
    <p>修改源码后重跑 <code>npm run build-bookmarklets</code> 重新生成本页</p>
  </div>
</body>
</html>
`;

fs.writeFileSync(OUT, html, 'utf8');
console.log(`✓ Generated ${OUT}`);
console.log(`  ${files.length} bookmarklets:`);
files.forEach((f) => console.log(`    - ${f}`));
