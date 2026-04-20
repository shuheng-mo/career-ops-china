// Mokahr 专用 JD 捕获 — v2 (2026-04-19 fix)
// 多家 AI 独角兽（DeepSeek / Moonshot / 旷视）用 Mokahr 作为社招 ATS。
//
// v2 变更：
// - 旧版 CSS selectors 在 2025+ Mokahr DOM 下失效 → 结构化字段全空
// - 改为解析 innerText 里的「职位信息」label-value 块（DeepSeek + Moonshot 两租户都稳定命中）
// - "分享" 锚点抽 title；pipe-header 做备用；CSS 降级为最后兜底
// - 租户识别从 hostname 改为 pathname（Mokahr tenant slug 在 path 而非子域名）

(async function () {
  document.querySelectorAll('*').forEach((el) => {
    try {
      el.style.userSelect = 'auto';
      el.style.webkitUserSelect = 'auto';
    } catch {}
  });

  let frameDoc = document;
  const mokahrFrame =
    document.querySelector('iframe[src*="mokahr.com"]') ||
    document.querySelector('iframe[src*="moka"]');
  if (mokahrFrame) {
    try {
      if (mokahrFrame.contentDocument) {
        frameDoc = mokahrFrame.contentDocument;
      }
    } catch {
      alert('⚠️ Mokahr iframe 是跨域的，无法直接读取。\n\n请在新 tab 打开 iframe 链接，再点这个 bookmarklet。');
      return;
    }
  }

  const rawFull = (frameDoc.body || document.body).innerText.trim();

  // ---- 主策略：解析 "职位信息" label-value 块 ----
  // Mokahr 表格典型形状（label 重复 2 次 + 值一行）：
  //   职位信息
  //   职位名称
  //   职位名称
  //   Agent 数据策略工程师
  //   薪资范围 / 薪资范围 / -
  //   职位性质 / 职位性质 / 全职
  //   职能类型 / 职能类型 / 其他
  //   所属部门 / 所属部门 / DeepSeek
  //   工作地点 / 工作地点 / 浙江·杭州市 北京市
  //   发布日期 / 发布日期 / 2026-04-17
  const FIELDS = ['职位名称', '薪资范围', '职位性质', '职能类型', '所属部门', '工作地点', '发布日期'];
  const parseInfoBlock = (text) => {
    const idx = text.indexOf('职位信息');
    if (idx < 0) return {};
    const tail = text.slice(idx).split('\n').map((s) => s.trim()).filter(Boolean);
    const out = {};
    for (let i = 0; i < tail.length; i++) {
      const line = tail[i];
      if (!FIELDS.includes(line)) continue;
      let j = i + 1;
      while (j < tail.length && tail[j] === line) j++;
      const value = tail[j] && !FIELDS.includes(tail[j]) ? tail[j] : '';
      if (value && value !== '-') out[line] = value;
    }
    return out;
  };

  // ---- 备用：顶部 pipe 头（"全职|其他|DeepSeek|浙江·杭州市 北京市"） ----
  const parsePipeHeader = (text) => {
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const shareIdx = lines.indexOf('分享');
    if (shareIdx < 0) return {};
    for (let i = shareIdx + 1; i < Math.min(shareIdx + 5, lines.length); i++) {
      if (lines[i].includes('|')) {
        const [nature, func, dept, loc] = lines[i].split('|').map((s) => s.trim());
        return {
          职位性质: nature || '',
          职能类型: func || '',
          所属部门: dept || '',
          工作地点: loc || '',
        };
      }
    }
    return {};
  };

  // ---- 标题：取 "分享" 前一行，若是 "急"/"热招" tag 再往前一行 ----
  const TITLE_TAGS = ['急', '热招', '紧急', 'HOT', 'NEW'];
  const TITLE_BLACKLIST = ['职位列表', '社招职位', '校招&实习职位', '登录', '首页', '关于我们'];
  const parseTitle = (text) => {
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const shareIdx = lines.indexOf('分享');
    if (shareIdx < 1) return '';
    let t = lines[shareIdx - 1];
    if (TITLE_TAGS.includes(t) && shareIdx >= 2) t = lines[shareIdx - 2];
    if (TITLE_BLACKLIST.includes(t)) return '';
    return t;
  };

  // ---- 描述：取 "职位描述" 到 "职位信息" 之间 ----
  const parseDescription = (text) => {
    const start = text.indexOf('职位描述');
    const end = text.indexOf('职位信息');
    if (start < 0) return '';
    const slice = end > start ? text.slice(start, end) : text.slice(start);
    return slice.trim();
  };

  // ---- CSS fallback（旧 DOM 或未知租户仍可能命中）----
  const pickCss = (selectors) => {
    for (const sel of selectors) {
      const el = frameDoc.querySelector(sel);
      if (el) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (txt) return txt;
      }
    }
    return '';
  };

  // ---- 租户→公司名 fallback（路径识别，不是 hostname）----
  const tenantCompany = (() => {
    const p = location.pathname;
    if (p.includes('high-flyer')) return 'DeepSeek';
    if (p.includes('moonshot')) return '月之暗面 Moonshot';
    if (p.includes('megviihr')) return '旷视';
    return '';
  })();

  const info = parseInfoBlock(rawFull);
  const header = parsePipeHeader(rawFull);
  const title = parseTitle(rawFull);
  const desc = parseDescription(rawFull);

  const extracted = {
    job_title:
      info['职位名称'] ||
      title ||
      pickCss(['.job-detail-title', '.position-name', '[class*="job-title"]', '[class*="position-title"]', 'h1', 'h2']),
    company:
      info['所属部门'] ||
      header['所属部门'] ||
      pickCss(['.company-name', '[class*="company"]', '.brand-name']) ||
      tenantCompany,
    location:
      info['工作地点'] ||
      header['工作地点'] ||
      pickCss(['.job-location', '[class*="location"]', '[class*="city"]']),
    salary: info['薪资范围'] || pickCss(['.salary', '[class*="salary"]']),
    job_type: info['职位性质'] || header['职位性质'] || '',
    function_category: info['职能类型'] || header['职能类型'] || '',
    published_at: info['发布日期'] || '',
    description:
      desc ||
      pickCss([
        '.job-detail-content',
        '.job-description',
        '.position-detail',
        '[class*="job-detail"]',
        '[class*="position-content"]',
        '[class*="content"]',
        '.job-content',
      ]),
  };

  const payload = {
    url: location.href,
    page_title: document.title,
    captured_at: new Date().toISOString(),
    platform: 'mokahr',
    extracted: { ...extracted, raw_text: rawFull },
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
          '\n地点：' + (extracted.location || '?') +
          '\n职能：' + (extracted.function_category || '?') +
          '\n发布：' + (extracted.published_at || '?') +
          '\n\n回到 Claude 跑 /career-ops inbox'
      );
    } else {
      alert('❌ Server error: ' + (result.error || 'unknown'));
    }
  } catch {
    alert('❌ 服务器没启动？\n\n请运行：node tools/jd-inbox-server.mjs');
  }
})();
