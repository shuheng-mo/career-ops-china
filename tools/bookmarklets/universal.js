// Universal JD Capture — works for ~80% of pages.
// Strips anti-copy CSS, finds main content block, posts JSON to local inbox server.
//
// Tested on: V2EX, GitHub, 公司自有 careers 静态页, 字节/腾讯/美团/快手/B站/网易/小红书 careers SPA
// (after page is fully loaded by user's browser).
//
// Doesn't work for: iframe-embedded ATS like Mokahr (use mokahr.js), 微信公众号 (encrypted DOM)

(async function () {
  const stripAntiCopy = () => {
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
  };
  stripAntiCopy();

  // Try common JD container selectors first; fallback to body.
  const SELECTORS = [
    '[class*="job-detail"]', '[class*="position-detail"]', '[class*="jd-content"]',
    '[class*="job-content"]', '[class*="job-description"]', '[class*="job-info"]',
    '[class*="position-content"]', '[class*="detail-content"]', '[class*="job-desc"]',
    '[class*="recruitDetail"]', '[class*="positionDetail"]',
    'main', 'article', '#main', '#content', '.content',
  ];

  let main = null;
  let bestLen = 0;
  for (const sel of SELECTORS) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      const len = (el.innerText || '').trim().length;
      if (len > bestLen && len > 200) {
        main = el;
        bestLen = len;
      }
    }
  }
  if (!main) main = document.body;

  // Best-effort structured extraction
  const text = main.innerText.trim();
  const titleGuess =
    document.querySelector('h1')?.innerText ||
    document.querySelector('[class*="title"]')?.innerText ||
    document.title;

  const payload = {
    url: location.href,
    page_title: document.title,
    captured_at: new Date().toISOString(),
    platform: 'universal',
    extracted: {
      job_title: (titleGuess || '').trim().slice(0, 200),
      raw_text: text,
    },
  };

  try {
    const res = await fetch('http://localhost:8787/jd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    if (result.ok) {
      alert('✓ JD captured\n→ ' + result.file + '\n\n回到 Claude 跑 /career-ops inbox 处理');
    } else {
      alert('❌ Server error: ' + (result.error || 'unknown'));
    }
  } catch (e) {
    alert('❌ 服务器没启动？\n\n请运行：\n  node tools/jd-inbox-server.mjs\n\n错误：' + e.message);
  }
})();
