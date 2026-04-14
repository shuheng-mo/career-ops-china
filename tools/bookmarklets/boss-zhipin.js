// Boss直聘（zhipin.com）专用 JD 捕获
// 处理 Boss 的反复制（user-select:none + copy event handler + 文本断裂）
// Selectors based on 2025-2026 Boss 详情页 DOM。如果 Boss 改版，universal.js fallback 也会工作。

(async function () {
  // 1. 强力剥离 anti-copy
  const allEls = document.querySelectorAll('*');
  allEls.forEach((el) => {
    try {
      el.style.userSelect = 'auto';
      el.style.webkitUserSelect = 'auto';
      el.style.mozUserSelect = 'auto';
      if (el.oncopy) el.oncopy = null;
      if (el.oncontextmenu) el.oncontextmenu = null;
      if (el.onselectstart) el.onselectstart = null;
    } catch {}
  });
  ['copy', 'cut', 'contextmenu', 'selectstart', 'mousedown'].forEach((evt) => {
    document.addEventListener(evt, (e) => e.stopPropagation(), true);
  });

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
    job_title: pickText(['.job-name', '.name h1', '[class*="job-title"]', 'h1']),
    company: pickText(['.company-name', '[class*="company-info"] a', '[class*="company"] .name']),
    salary: pickText(['.job-salary', '.salary', '[class*="salary"]']),
    location: pickText(['.job-location', '.location-address', '[class*="location"]', '[class*="city"]']),
    seniority_experience: pickText(['.job-experience', '[class*="experience"]', '[class*="text-experience"]']),
    description: pickText([
      '.job-detail-section',
      '.job-detail-content',
      '.job-sec-text',
      '.job-detail',
      '[class*="job-detail"]',
    ]),
    requirements: pickText(['.job-tags', '[class*="job-keyword"]', '[class*="job-tag"]']),
  };

  const payload = {
    url: location.href,
    page_title: document.title,
    captured_at: new Date().toISOString(),
    platform: 'boss-zhipin',
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
        '✓ Boss直聘 JD captured\n→ ' + result.file +
          '\n\n岗位：' + (extracted.job_title || '?') +
          '\n公司：' + (extracted.company || '?') +
          '\n薪资：' + (extracted.salary || '?') +
          '\n\n回到 Claude 跑 /career-ops inbox'
      );
    } else {
      alert('❌ Server error: ' + (result.error || 'unknown'));
    }
  } catch (e) {
    alert('❌ 服务器没启动？\n\n请运行：\n  node tools/jd-inbox-server.mjs\n\n错误：' + e.message);
  }
})();
