// Boss直聘（zhipin.com）专用 JD 捕获
// 处理 Boss 的反复制（user-select:none + copy event handler + 文本断裂）
// Selectors 基于 2025-2026 Boss 详情页 DOM。Boss 改版时 universal.js fallback 也会工作。
//
// ⚠️ 2026-04-15 修复 company 错抽 bug：
// 旧版 .company-name 全局匹配会拿到**侧栏推荐岗位**或广告位的公司名，
// 而不是当前查看的真实发岗方（观察到 9 条 JD 里 8 条 company 被错抽成
// "岚图汽车" / "西湖心辰" / "蚂蚁集团" / "高德地图" 等推荐位公司）。
// 修复策略：
//   1. 优先在 .job-banner / .job-primary / .info-primary 等主岗位容器内找
//   2. 排除 .sider / .recommend / [class*="other-job"] 等推荐位
//   3. 兜底从 HR 签名段（.boss-info）反推真实发岗方
//   4. 最后兜底从 body 正则提取 "HR名字 状态 公司名 · HR职位" 模式

(async function () {
  // === 1. 强力剥离 anti-copy（沿用旧版，稳定） ===
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

  // === 2. DOM 范围约束（针对 2026-04 company 错抽 bug） ===
  const PRIMARY_CONTAINERS = [
    '.job-banner',
    '.job-primary',
    '.info-primary',
    '.job-detail-box',
    '.job-container',
    '[class*="detail-primary"]',
    '[class*="job-detail"]:not([class*="recommend"]):not([class*="related"])',
  ];
  const EXCLUDE_SELECTORS = [
    '.sider', '.side-bar', '.recommend-list', '.recommend-jobs',
    '[class*="recommend"]', '[class*="related"]', '[class*="similar"]',
    '[class*="other-job"]', '.job-history', '.job-list',
    '.job-card', // 推荐岗位卡片
  ];
  const EXCLUDE_SELECTOR_STR = EXCLUDE_SELECTORS.join(', ');

  const isInExcluded = (el) => {
    try { return !!el.closest(EXCLUDE_SELECTOR_STR); } catch { return false; }
  };

  const readText = (el) => {
    if (!el) return '';
    const txt = (el.innerText || el.textContent || '').trim();
    return txt;
  };

  // 先在主岗位容器内找；找不到再全局找但排除推荐位
  const pickScoped = (subSelectors) => {
    for (const container of PRIMARY_CONTAINERS) {
      const c = document.querySelector(container);
      if (!c || isInExcluded(c)) continue;
      for (const sel of subSelectors) {
        const el = c.querySelector(sel);
        const t = readText(el);
        if (t) return t;
      }
    }
    for (const sel of subSelectors) {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els) {
        if (isInExcluded(el)) continue;
        const t = readText(el);
        if (t) return t;
      }
    }
    return '';
  };

  // === 3. 从 HR 签名段反推真实 company（最稳的兜底） ===
  const HR_TITLE_PATTERN = /(?:HR|人力|招聘|猎头|顾问|HRBP|经理|专员|研发HR|总监|BP|Manager|Recruiter|高级人力|助理)/i;
  const ACTIVITY_PATTERN = /(?:在线|刚刚活跃|本月活跃|近期活跃|[0-9]+\s*(?:分钟|小时|天)前活跃)/;

  const extractCompanyFromHR = () => {
    // 3a. 先找 class 含 boss/hr/author/publisher 的 DOM
    const hrDomSelectors = [
      '.boss-info', '.hr-info', '.job-author', '.job-publisher',
      '[class*="boss-name"]', '[class*="hr-card"]', '[class*="publisher"]', '[class*="recruiter"]',
      '[class*="op-info"]',
    ];
    for (const sel of hrDomSelectors) {
      const el = document.querySelector(sel);
      if (!el || isInExcluded(el)) continue;
      const txt = readText(el);
      // 格式 "HR名 [活跃] 公司名 · HR职位"
      // 拿 · 前的最后一段作为公司名
      const parts = txt.split('·').map((s) => s.trim());
      if (parts.length >= 2 && HR_TITLE_PATTERN.test(parts[parts.length - 1])) {
        // 前半段 = "HR名 [活跃] 公司名"，取末尾一个词组
        const pre = parts.slice(0, -1).join('·').trim();
        // 去掉活跃状态关键字
        let co = pre.replace(ACTIVITY_PATTERN, '').trim();
        // 去掉 HR 名字（通常是 2-4 字 + 女士/先生，或英文姓名）
        co = co.replace(/^[^\s]{2,10}(女士|先生|小姐)\s+/, '').trim();
        co = co.replace(/^[A-Z][a-z]+\s+[A-Z][a-z]+\s+/, '').trim();
        // 空格 split 后取最长的一段作为公司名（最稳的启发式）
        const tokens = co.split(/\s+/).filter(Boolean);
        if (tokens.length >= 1) {
          const longest = tokens.reduce((a, b) => (b.length > a.length ? b : a), '');
          if (longest.length >= 2) return longest;
        }
        if (co) return co;
      }
    }

    // 3b. 全 body innerText 正则兜底
    const bodyTxt = document.body.innerText;
    const pattern = new RegExp(
      String.raw`(?:^|\n)\s*[^\s\n·]{2,10}(?:\s+` + ACTIVITY_PATTERN.source + String.raw`)?\s+([^\s\n·]{2,40})\s*·\s*` + HR_TITLE_PATTERN.source,
      'm'
    );
    const m = bodyTxt.match(pattern);
    if (m && m[1]) return m[1].trim();
    return '';
  };

  // === 4. 字段抽取（company 走新逻辑，其他沿用旧版） ===
  const jobTitleRaw = pickScoped(['.job-name', '.name h1', '[class*="job-title"]', 'h1']);
  const salaryRaw = pickScoped(['.job-salary', '.salary', '[class*="salary"]']);
  const locationRaw = pickScoped(['.job-location', '.location-address', '[class*="location"]', '[class*="city"]']);
  const seniorityRaw = pickScoped(['.job-experience', '[class*="experience"]', '[class*="text-experience"]']);
  const descriptionRaw = pickScoped([
    '.job-detail-section',
    '.job-detail-content',
    '.job-sec-text',
    '.job-detail',
    '[class*="job-detail"]',
  ]);
  const requirementsRaw = pickScoped(['.job-tags', '[class*="job-keyword"]', '[class*="job-tag"]']);

  // company：主卡片优先 → HR 反推兜底
  let companyRaw = pickScoped([
    '.company-name', '.info-company .name', '.info-company a',
    '[class*="company-info"] .name', '[class*="company-info"] a',
    '.company-info-box .name',
  ]);
  const companyFromHR = extractCompanyFromHR();
  // 启发式校验：如果主卡片抽到的 company 看起来像推荐位（极短/含数字/明显异常）
  // 或者和 HR 反推结果差异很大，以 HR 为准
  const looksDubious = (c) => {
    if (!c) return true;
    if (c.length < 2 || c.length > 40) return true;
    // 如果主卡片和 HR 反推都有值且不一致，优先信 HR（因为 HR 更稳）
    return false;
  };
  let company = companyRaw;
  if (companyFromHR) {
    // 如果 HR 反推和主卡片不同，优先用 HR（HR 签名是权威）
    if (!companyRaw || companyFromHR !== companyRaw) {
      company = companyFromHR;
    }
  }
  if (!company || looksDubious(company)) company = companyRaw || companyFromHR || '';

  const extracted = {
    job_title: jobTitleRaw,
    company,                        // ← 修复后的 company
    company_from_card: companyRaw,  // 保留主卡片原始值供调试
    company_from_hr: companyFromHR, // 保留 HR 反推值供调试
    salary: salaryRaw,
    location: locationRaw,
    seniority_experience: seniorityRaw,
    description: descriptionRaw,
    requirements: requirementsRaw,
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
      const debugLine = (companyRaw && companyFromHR && companyRaw !== companyFromHR)
        ? '\n(⚠️ 主卡片抽到 "' + companyRaw + '"，HR 反推 "' + companyFromHR + '"，已选 HR)'
        : '';
      alert(
        '✓ Boss直聘 JD captured\n→ ' + result.file +
          '\n\n岗位：' + (extracted.job_title || '?') +
          '\n公司：' + (company || '?') + debugLine +
          '\n薪资：' + (extracted.salary || '?') +
          '\n\n回到 Claude 跑 /career-ops inbox'
      );
    } else {
      alert('❌ Server error: ' + (result.error || 'unknown'));
    }
  } catch (e) {
    alert('❌ 服务器没启动？\n\n请运行：\n  npm run inbox-server\n（即 node tools/jd-inbox-server.mjs）\n\n错误：' + e.message);
  }
})();
