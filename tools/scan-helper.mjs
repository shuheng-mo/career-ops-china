#!/usr/bin/env node

/**
 * scan-helper.mjs — 用 Playwright 桥接 SPA careers 页和 JD 详情页
 *
 * 用法:
 *   node tools/scan-helper.mjs <URL> [--mode=jd|list] [--wait=5000] [--format=text|json]
 *
 * 模式:
 *   --mode=jd    （默认）提取整个页面的可见文本内容（适合 JD 详情页）
 *   --mode=list  提取页面中所有看起来像职位链接的 (title, url) 列表（适合 careers 列表页）
 *
 * 例:
 *   node tools/scan-helper.mjs "https://jobs.bytedance.com/experienced/position/6820281790835951885" --mode=jd
 *   node tools/scan-helper.mjs "https://www.zhipin.com/web/geek/job?query=数据" --mode=list
 *
 * 输出: stdout（让 Bash 直接捕获）
 *
 * 注意:
 *   - 默认 headless，国内多数大厂 careers 页可正常渲染
 *   - Boss/拉勾/猎聘 详情页有滑块验证，需要复用登录态（看 --user-data-dir）
 *   - 默认等 networkidle + 5 秒额外等待让 SPA 渲染完成
 */

import { chromium } from 'playwright';

async function main() {
  const args = process.argv.slice(2);
  let url = null;
  let mode = 'jd';
  let waitMs = 5000;
  let format = 'text';
  let userDataDir = null;

  for (const arg of args) {
    if (arg.startsWith('--mode=')) mode = arg.split('=')[1];
    else if (arg.startsWith('--wait=')) waitMs = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--format=')) format = arg.split('=')[1];
    else if (arg.startsWith('--user-data-dir=')) userDataDir = arg.split('=')[1];
    else if (!url) url = arg;
  }

  if (!url) {
    console.error('Usage: node tools/scan-helper.mjs <URL> [--mode=jd|list] [--wait=5000] [--format=text|json] [--user-data-dir=PATH]');
    process.exit(1);
  }

  let browser = null;
  let context = null;

  try {
    if (userDataDir) {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: { width: 1440, height: 900 },
      });
    } else {
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
      });
    }

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch {
      // networkidle 超时不算致命，继续
    }

    if (waitMs > 0) await page.waitForTimeout(waitMs);

    // 检测常见的反爬/登录墙
    const pageTitle = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const isBlocked = (
      pageTitle.includes('安全验证') ||
      pageTitle.includes('登录') ||
      bodyText.includes('请完成安全验证') ||
      bodyText.includes('请滑动') ||
      bodyText.length < 200  // 几乎没内容大概率是 SPA 没渲染或被挡
    );

    if (mode === 'list') {
      // 提取所有看起来像职位链接的 anchor
      const links = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a'));
        return anchors
          .map(a => ({
            title: (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' '),
            url: a.href,
          }))
          .filter(item =>
            item.title.length > 2 &&
            item.title.length < 200 &&
            item.url &&
            item.url.startsWith('http') &&
            // 排除导航/footer 链接
            !/(关于|联系|首页|登录|注册|帮助|隐私|协议|友情|微博|微信|App|下载)$/i.test(item.title)
          );
      });

      const result = {
        url,
        title: pageTitle,
        blocked: isBlocked,
        link_count: links.length,
        links: links.slice(0, 200),  // 限 200 条避免输出过大
      };

      if (format === 'json') {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`# Page: ${pageTitle}`);
        console.log(`# URL: ${url}`);
        console.log(`# Blocked: ${isBlocked}`);
        console.log(`# Found ${links.length} links\n`);
        for (const link of result.links) {
          console.log(`- [${link.title}](${link.url})`);
        }
      }
    } else {
      // mode=jd: 提取整个页面文本
      const result = {
        url,
        title: pageTitle,
        blocked: isBlocked,
        text_length: bodyText.length,
        text: bodyText,
      };

      if (format === 'json') {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`# Page Title: ${pageTitle}`);
        console.log(`# URL: ${url}`);
        console.log(`# Blocked: ${isBlocked}`);
        console.log(`# Text Length: ${bodyText.length} chars`);
        console.log(`\n--- BEGIN PAGE TEXT ---\n`);
        console.log(bodyText);
        console.log(`\n--- END PAGE TEXT ---`);
      }
    }
  } catch (err) {
    console.error('❌ Scan failed:', err.message);
    process.exit(2);
  } finally {
    if (browser) await browser.close();
    else if (context) await context.close();
  }
}

main();
