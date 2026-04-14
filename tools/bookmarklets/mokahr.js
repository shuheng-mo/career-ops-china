// Mokahr 专用 JD 捕获
// 多家 AI 独角兽（DeepSeek / 部分大厂）用 Mokahr 作为社招 ATS。
// Mokahr 通常嵌入在 iframe 里，需要尝试穿透 iframe 取内容。

(async function () {
  document.querySelectorAll('*').forEach((el) => {
    try {
      el.style.userSelect = 'auto';
      el.style.webkitUserSelect = 'auto';
    } catch {}
  });

  // 尝试找 Mokahr iframe（同源时可访问）
  let frameDoc = document;
  const mokahrFrame =
    document.querySelector('iframe[src*="mokahr.com"]') ||
    document.querySelector('iframe[src*="moka"]');
  if (mokahrFrame) {
    try {
      if (mokahrFrame.contentDocument) {
        frameDoc = mokahrFrame.contentDocument;
      }
    } catch (e) {
      alert('⚠️ Mokahr iframe 是跨域的，无法直接读取。\n\n请直接打开 iframe 内的链接（在新 tab 打开 iframe），然后再点这个 bookmarklet。');
      return;
    }
  }

  const pickText = (selectors) => {
    for (const sel of selectors) {
      const el = frameDoc.querySelector(sel);
      if (el) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (txt.length > 0) return txt;
      }
    }
    return '';
  };

  const extracted = {
    job_title: pickText([
      '.job-detail-title', '.position-name', '[class*="job-title"]',
      '[class*="position-title"]', 'h1', 'h2',
    ]),
    company: pickText([
      '.company-name', '[class*="company"]',
      '.brand-name',
    ]) || (location.hostname.includes('high-flyer') ? 'DeepSeek' : ''),
    location: pickText(['.job-location', '[class*="location"]', '[class*="city"]']),
    salary: pickText(['.salary', '[class*="salary"]']),
    description: pickText([
      '.job-detail-content', '.job-description', '.position-detail',
      '[class*="job-detail"]', '[class*="position-content"]',
      '[class*="content"]', '.job-content',
    ]),
  };

  // raw_text 兜底
  const raw = (frameDoc.body || document.body).innerText.trim();

  const payload = {
    url: location.href,
    page_title: document.title,
    captured_at: new Date().toISOString(),
    platform: 'mokahr',
    extracted: { ...extracted, raw_text: raw },
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
        '✓ Mokahr JD captured\n→ ' + result.file +
          '\n\n岗位：' + (extracted.job_title || '?') +
          '\n公司：' + (extracted.company || '?') +
          '\n\n回到 Claude 跑 /career-ops inbox'
      );
    } else {
      alert('❌ Server error: ' + (result.error || 'unknown'));
    }
  } catch (e) {
    alert('❌ 服务器没启动？\n\n请运行：node tools/jd-inbox-server.mjs');
  }
})();
