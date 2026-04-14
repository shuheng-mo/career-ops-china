// 拉勾（lagou.com）专用 JD 捕获
// 拉勾详情页有反爬，但用户登录后 DOM 是可读的

(async function () {
  document.querySelectorAll('*').forEach((el) => {
    try {
      el.style.userSelect = 'auto';
      el.style.webkitUserSelect = 'auto';
      if (el.oncopy) el.oncopy = null;
    } catch {}
  });
  ['copy', 'cut', 'contextmenu', 'selectstart'].forEach((evt) => {
    document.addEventListener(evt, (e) => e.stopPropagation(), true);
  });

  const bodyText = document.body.innerText || '';
  if (/请\s*登录|登录后|立即登录/.test(bodyText) && bodyText.length < 1200) {
    alert('⚠️ 拉勾要求登录\n\n先登录后刷新页面，再点 bookmarklet。');
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
    job_title: pickText(['.job-name .name', '.position-head h1', '[class*="position-content"] h1', 'h1']),
    company: pickText(['.company .name', '.company_name', '[class*="company-info"] .name']),
    salary: pickText(['.salary', '[class*="salary"]', '.job_request .salary']),
    location: pickText(['.work_addr', '[class*="work-addr"]', '[class*="location"]']),
    description: pickText([
      '.job-detail',
      '#job_detail',
      '.job_bt',
      '[class*="job-detail"]',
      '[class*="job-description"]',
    ]),
    requirements: pickText(['.position-label', '[class*="position-tag"]', '[class*="job-keyword"]']),
  };

  const payload = {
    url: location.href,
    page_title: document.title,
    captured_at: new Date().toISOString(),
    platform: 'lagou',
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
        '✓ 拉勾 JD captured\n→ ' + result.file +
          '\n\n岗位：' + (extracted.job_title || '?') +
          '\n公司：' + (extracted.company || '?')
      );
    } else {
      alert('❌ Server error: ' + (result.error || 'unknown'));
    }
  } catch (e) {
    alert('❌ 服务器没启动？\n\n请运行：node tools/jd-inbox-server.mjs');
  }
})();
