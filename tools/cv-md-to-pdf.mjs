#!/usr/bin/env node
// cv-md-to-pdf.mjs — tailored CV markdown → PDF (Playwright).
//
// Usage:
//   npm run cv -- output/cv-candidate-xxx.md [more.md ...] [--format=a4|letter] [--html]
//
// Writes the PDF next to each .md (same basename). --html also keeps the
// intermediate .html for debugging. The markdown is the editable source of
// truth: fix a typo in the .md, rerun the command, done.
//
// Markdown conventions (plain markdown, nothing exotic):
//   # 姓名
//   联系方式行（# 和第一个 ## 之间的段落 = 页眉联系信息，小字）
//   ## 专业摘要 / 项目经历 / 工作经历 / ...
//   ### 条目标题　2023.03 – 2024.08     ← 以日期区间结尾的 ### 自动把日期右对齐
//   段落、- 列表、**加粗** 照常写
//
// Hard rules (candidate's explicit requirement, 2026-10-11):
//   - every glyph is black (#000) — the stylesheet below has no other color
//   - no arrow chains in the text: the build FAILS if the text contains → ⇒ ➜ or ->

import { chromium } from 'playwright';
import { marked } from 'marked';
import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname, basename, extname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = `file://${join(ROOT, 'fonts')}`;

// Ends with "2023.03 – 2024.08" / "2025.08 — 至今" / "2024.08-至今" / "2025.08 – Present" (English CVs)
const DATE_TAIL = /\s*(\d{4}\.\d{1,2}\s*[–—-]+\s*(?:\d{4}\.\d{1,2}|至今|今|Present))\s*$/;

const CSS = `
@font-face { font-family: 'DM Sans'; src: url('${FONTS}/dm-sans-latin.woff2') format('woff2'); font-weight: 100 1000; }
@font-face { font-family: 'DM Sans'; src: url('${FONTS}/dm-sans-latin-ext.woff2') format('woff2'); font-weight: 100 1000; }
@font-face { font-family: 'Space Grotesk'; src: url('${FONTS}/space-grotesk-latin.woff2') format('woff2'); font-weight: 300 700; }
* { margin: 0; padding: 0; box-sizing: border-box; color: #000 !important; }
body {
  font-family: 'DM Sans', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif;
  font-size: 10.5px; line-height: 1.55; background: #fff;
}
h1 { font-family: 'Space Grotesk', 'PingFang SC', sans-serif; font-size: 22px; font-weight: 700; margin-bottom: 4px; }
.contact { font-size: 9.5px; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1.5px solid #000; }
.contact p { margin: 0; }
h2 {
  font-family: 'Space Grotesk', 'PingFang SC', sans-serif; font-size: 13px; font-weight: 700;
  margin: 12px 0 6px; padding-bottom: 2px; border-bottom: 0.5px solid #000; break-after: avoid;
}
h3 { font-size: 11px; font-weight: 700; margin: 8px 0 2px; display: flex; justify-content: space-between; gap: 12px; break-after: avoid; }
h3 .date { font-weight: 400; white-space: nowrap; }
p { margin: 2px 0 4px; text-align: justify; }
ul { margin: 2px 0 4px 1.3em; }
li { margin: 1px 0; }
strong { font-weight: 700; }
a { text-decoration: none; }
`;

marked.use({
  gfm: true,
  renderer: {
    heading(text, level) {
      if (level === 3) {
        const m = text.match(DATE_TAIL);
        if (m) return `<h3><span>${text.slice(0, m.index)}</span><span class="date">${m[1]}</span></h3>\n`;
      }
      return `<h${level}>${text}</h${level}>\n`;
    },
  },
});

function buildHtml(md) {
  let body = marked.parse(md);
  // Paragraphs between the name and the first section are the contact block.
  body = body.replace(/(<\/h1>\n)([\s\S]*?)(?=<h2>)/, (_, h1, contact) => `${h1}<div class="contact">${contact}</div>\n`);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${CSS}</style></head><body>${body}</body></html>`;
}

function arrowViolations(html) {
  const text = html.split('<body>')[1].replace(/<[^>]+>/g, '');
  return text.split(/[。；\n]/).map(s => s.trim()).filter(s => /[→⇒➜]|->/.test(s));
}

async function main() {
  const args = process.argv.slice(2);
  const format = (args.find(a => a.startsWith('--format='))?.split('=')[1] || 'a4').toLowerCase();
  const keepHtml = args.includes('--html');
  const inputs = args.filter(a => !a.startsWith('--'));
  if (!inputs.length) {
    console.error('Usage: npm run cv -- <cv.md> [more.md ...] [--format=a4|letter] [--html]');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  try {
    for (const input of inputs) {
      const src = resolve(input);
      const out = join(dirname(src), basename(src, extname(src)) + '.pdf');
      const html = buildHtml(await readFile(src, 'utf8'));

      const bad = arrowViolations(html);
      if (bad.length) {
        console.error(`❌ ${input}: 正文里有箭头，改成通顺的中文句子再生成：`);
        bad.forEach(s => console.error(`   · ${s.slice(0, 100)}`));
        failed++;
        continue;
      }
      if (keepHtml) await writeFile(out.replace(/\.pdf$/, '.html'), html);

      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      const pdf = await page.pdf({
        format, printBackground: true,
        margin: { top: '0.55in', right: '0.6in', bottom: '0.55in', left: '0.6in' },
      });
      await page.close();
      await writeFile(out, pdf);
      const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
      console.log(`✅ ${out}  (${pages} 页${pages > 2 ? ' ⚠️ 超过 2 页' : ''})`);
    }
  } finally {
    await browser.close();
  }
  if (failed) process.exit(1);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
