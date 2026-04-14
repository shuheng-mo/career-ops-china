// 猎聘（liepin.com）专用 JD 捕获
// 猎聘部分详情页有反复制 + 登录墙（未登录看不到完整 JD）

(async function () {
  // 强剥 anti-copy
  document.querySelectorAll('*').forEach((el) => {
    try {
      el.style.userSelect = 'auto';
      el.style.webkitUserSelect = 'auto';
      if (el.oncopy) el.oncopy = null;
      if (el.oncontextmenu) el.oncontextmenu = null;
    } catch {}
  });
  ['copy', 'cut', 'contextmenu', 'selectstart'].forEach((evt) => {
    document.addEventListener(evt, (e) => e.stopPropagation(), true);
  });

  // 检测登录墙
  const bodyText = document.body.innerText || '';
  if (/请\s*登录|登录后查看|立即登录|登录\s*并\s*查看/.test(bodyText) && bodyText.length < 1500) {
    alert('⚠️ 猎聘要求登录后才能看完整 JD\n\n请先登录猎聘账号，刷新页面后再点这个 bookmarklet。');
    return;
  }

  const pickText = (selectors) => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (txt.length > 0) return txt;
      }
    }
    return '';
  };

  const extracted = {
    job_title: pickText([
      '.title-info h1', '.job-title-wrap h1',
      '[class*="job-title-name"]', '[class*="title-info"] h1', 'h1',
    ]),
    company: pickText([
      '.company-info-container .name', '[class*="company-name"]',
      '.company-name a', '[class*="company-info"] .name',
    ]),
    salary: pickText(['.job-item-title .salary', '[class*="salary"]', '.salary']),
    location: pickText(['.basic-infor span:first-child', '[class*="job-place"]', '[class*="location"]']),
    description: pickText([
      '.job-intro-content', '.job-describe-content', '.content.content-word',
      '[class*="job-describe"]', '[class*="job-intro"]', '[class*="job-detail"]',
    ]),
    requirements: pickText(['.job-item-list', '[class*="tag-list"]', '[class*="labels"]']),
  };

  const payload = {
    url: location.href,
    page_title: document.title,
    captured_at: new Date().toISOString(),
    platform: 'liepin',
    extracted: { ...extracted, raw_text: document.body.innerText.trim() },
  };

  try {
    const res = await fetch('http://localhost:8787/jd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    if (result.ok) {
      alert(
        '✓ 猎聘 JD captured\n→ ' + result.file +
          '\n\n岗位：' + (extracted.job_title || '?') +
          '\n公司：' + (extracted.company || '?') +
          '\n\n回到 Claude 跑 /career-ops inbox'
      );
    } else {
      alert('❌ Server error: ' + (result.error || 'unknown'));
    }
  } catch (e) {
    alert('❌ 服务器没启动？\n\n请运行：\n  node tools/jd-inbox-server.mjs\n\n错误：' + e.message);
  }
})();
