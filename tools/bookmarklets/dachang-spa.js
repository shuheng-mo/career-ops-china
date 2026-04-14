// 大厂 Careers SPA 通用捕获
// 适用于：字节 / 阿里 / 蚂蚁 / 腾讯 / 美团 / 快手 / 小红书 careers /
//        B站 / 网易 / 京东 / 拼多多 / 百度 / 滴滴 / DeepSeek www
//        以及多家 AI 独角兽（智谱 / MiniMax / 阶跃 / 面壁 等）
// 这些站点的 careers 详情页是 SPA，但用户在浏览器打开后 DOM 已渲染好。
// universal.js 也能跑，本 bookmarklet 增加了大厂 SPA 常见 selector 的优先尝试。

(async function () {
  document.querySelectorAll('*').forEach((el) => {
    try {
      el.style.userSelect = 'auto';
      el.style.webkitUserSelect = 'auto';
      if (el.oncopy) el.oncopy = null;
    } catch {}
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

  // 大厂常用 selector 集合（按命中率排序）
  const TITLE_SELS = [
    '[class*="position-title"]', '[class*="job-title"]', '[class*="positionName"]',
    '[class*="recruit-title"]', '[class*="position-name"]', '[class*="jobName"]',
    '.position-detail h1', '.job-detail h1', 'h1.title', 'h1',
  ];
  const COMPANY_SELS = [
    '[class*="company-name"]', '[class*="brand-name"]', '[class*="companyName"]',
  ];
  const LOCATION_SELS = [
    '[class*="position-location"]', '[class*="job-location"]', '[class*="city"]',
    '[class*="address"]', '[class*="location-info"]',
  ];
  const DEPT_SELS = [
    '[class*="department"]', '[class*="team"]', '[class*="position-team"]',
    '[class*="bg-name"]',
  ];
  const DESC_SELS = [
    '[class*="job-detail"]', '[class*="position-detail"]', '[class*="recruit-content"]',
    '[class*="position-description"]', '[class*="job-description"]',
    '[class*="position-content"]', '[class*="job-content"]',
    '[class*="positionDetail"]', '[class*="positionDesc"]',
    '.detail-content', '.content-detail', 'main', 'article',
  ];

  // Smart fallback: pick the largest non-nav block
  let descText = pickText(DESC_SELS);
  if (descText.length < 200) {
    let best = null;
    let bestLen = 0;
    document.querySelectorAll('div, section, article, main').forEach((el) => {
      const cls = (el.className || '').toString().toLowerCase();
      if (/nav|footer|header|sidebar|menu|modal|toast/.test(cls)) return;
      const len = (el.innerText || '').trim().length;
      if (len > bestLen && len > 200 && len < 30000) {
        best = el;
        bestLen = len;
      }
    });
    if (best) descText = best.innerText.trim();
  }

  // 公司名兜底：从 hostname 推断
  const HOST_TO_COMPANY = {
    'jobs.bytedance.com': '字节跳动',
    'talent.alibaba.com': '阿里巴巴',
    'talent.antgroup.com': '蚂蚁集团',
    'careers.tencent.com': '腾讯',
    'zhaopin.meituan.com': '美团',
    'zhaopin.kuaishou.cn': '快手',
    'job.xiaohongshu.com': '小红书',
    'jobs.bilibili.com': 'B 站',
    'hr.163.com': '网易',
    'campus.163.com': '网易',
    'join.jd.com': '京东',
    'careers.pinduoduo.com': '拼多多',
    'talent.baidu.com': '百度',
    'talent.didiglobal.com': '滴滴',
    'www.deepseek.com': 'DeepSeek',
    'www.moonshot.cn': 'Moonshot 月之暗面',
    'www.zhipuai.cn': '智谱 AI',
    'www.minimaxi.com': 'MiniMax',
    'www.baichuan-ai.com': '百川智能',
    '01.ai': '零一万物',
    'www.stepfun.com': '阶跃星辰',
    'www.modelbest.cn': '面壁智能',
    'www.pingcap.com': 'PingCAP',
    'www.starrocks.io': 'StarRocks',
    'kyligence.io': 'Kyligence',
    'www.sensorsdata.cn': '神策数据',
    'siliconflow.cn': '硅基流动',
    'www.luchentech.com': '潞晨科技',
    'infini-ai.com': '无问芯穹',
    'www.4paradigm.com': '第四范式',
    'www.sensetime.com': '商汤',
    'www.megvii.com': '旷视',
    'www.langboat.com': '澜舟科技',
  };
  const companyByHost = HOST_TO_COMPANY[location.hostname] || '';

  const extracted = {
    job_title: pickText(TITLE_SELS),
    company: pickText(COMPANY_SELS) || companyByHost,
    location: pickText(LOCATION_SELS),
    department: pickText(DEPT_SELS),
    description: descText,
  };

  const payload = {
    url: location.href,
    page_title: document.title,
    captured_at: new Date().toISOString(),
    platform: 'dachang-spa',
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
        '✓ 大厂 SPA JD captured\n→ ' + result.file +
          '\n\n公司：' + (extracted.company || '?') +
          '\n岗位：' + (extracted.job_title || '?') +
          '\n地点：' + (extracted.location || '?') +
          '\n\n回到 Claude 跑 /career-ops inbox'
      );
    } else {
      alert('❌ Server error: ' + (result.error || 'unknown'));
    }
  } catch (e) {
    alert('❌ 服务器没启动？\n\n请运行：node tools/jd-inbox-server.mjs');
  }
})();
