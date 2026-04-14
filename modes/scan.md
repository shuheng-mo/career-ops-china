# Mode: scan — 门户扫描器（中国大陆版）

扫描配置好的招聘门户和公司 careers 页，按标题相关性过滤，把新职位塞进 pipeline 等待评估。

## 推荐执行方式

作为 subagent 跑，避免污染主上下文：

```
Agent(
    subagent_type="general-purpose",
    prompt="[本文件内容 + 具体数据]",
    run_in_background=True
)
```

## 配置

读 `portals.yml`：
- `search_queries` — WebSearch queries 带 `site:` 过滤（广度发现）
- `tracked_companies` — 直接抓的公司列表，每条带 `careers_url`
- `title_filter` — positive/negative/seniority_boost 关键词

## 中国大陆特殊情况 ⚠️

国内招聘门户和西方差异很大，**默认 Playwright 抓取大概率会失败**。原因：

| 平台 | 问题 | 应对 |
|------|------|------|
| **Boss直聘（zhipin.com）** | 必须登录才能看 JD；强反爬（滑块/IP 封禁/手机验证） | 不放进自动 scan，**只用「人工贴 URL → offer 评估」模式** |
| **拉勾（lagou.com）** | 部分岗位需登录；反爬中等 | 可以用 WebSearch 发现，但 JD 提取常需要人工 |
| **猎聘（liepin.com）** | 列表页可看，详情页要登录；反爬中等 | 同拉勾 |
| **智联招聘（zhaopin.com）** | 列表可看，详情可看但反爬严 | 可以试 Playwright，频率必须低 |
| **51job（51job.com）** | 反爬较弱 | OK |
| **脉脉招聘** | 必须登录 | 不放进自动 scan |
| **大厂自有 careers 页** | 多数无需登录（字节/阿里/腾讯/美团/快手/小红书 等） | ✅ **首选方式 — Playwright 直抓** |
| **AI 独角兽 careers 页** | 多数无需登录，但有些是飞书表单嵌入 | ✅ Playwright 直抓 |

**总策略：**
1. **大厂和独角兽** 用 Playwright 直接抓 careers 页（Level 1）
2. **门户站（Boss/拉勾/猎聘）** 只用 WebSearch 发现 URL，不尝试自动抓 JD（Level 3）
3. **抓不到的 URL** 标记 `[!]` 留给人工

### 复用登录态的高级方案（可选）

如果你愿意让 Claude 用你的 Chrome 登录态：

```bash
# 用 Playwright 启动一个绑定你 Chrome user data 的实例
npx playwright launch --user-data-dir="$HOME/Library/Application Support/Google/Chrome/Default"
```

或者在 Claude Code 里用 `claude --chrome` 模式（参考 `modes/batch.md`），让它复用你已登录的 Chrome 来浏览 Boss/脉脉。**但要注意：高频访问会被封号，频率自己掌握。**

## 三层发现策略

### Level 1 — Playwright 直抓（主力）

**对每个 `tracked_companies` 中的公司：** 用 Playwright `browser_navigate` + `browser_snapshot` 直接打开 careers 页，读所有可见的 job listing，提取 title + URL。这是最可靠的方式：

- 实时看到页面（不依赖 Google 缓存）
- 能处理 SPA（飞书表单、自有 SPA 等）
- 新岗位即时发现
- 不依赖 Google 索引

**每个公司必须有 `careers_url`。** 没有就找一次、存进 portals.yml、之后复用。

**国内大厂的 careers 页大致模式：**
- 字节跳动：`https://jobs.bytedance.com/experienced/position`
- 阿里巴巴：`https://talent.alibaba.com/off-campus`
- 腾讯：`https://careers.tencent.com/search.html`
- 美团：`https://zhaopin.meituan.com/web/position`
- 小红书：`https://job.xiaohongshu.com`
- 快手：`https://campus.kuaishou.cn`（应届）/ `https://zhaopin.kuaishou.cn`（社招）
- 拼多多：`https://careers.pinduoduo.com`
- B 站：`https://jobs.bilibili.com`
- 网易：`https://hr.163.com/job-list.html`

### Level 2 — Greenhouse / Lever / Ashby API（仅少数中国公司）

国内少数有海外业务的公司用 Greenhouse（如 PingCAP 部分海外岗）。绝大多数用自有 careers 页或飞书表单 — 这一层在中国大陆基本不适用，**默认禁用**。

### Level 3 — WebSearch（广度发现）

`search_queries` 用 `site:` 过滤覆盖各门户：

**国内门户的常用 query 模式：**
```
site:zhipin.com "数据工程师" OR "大模型" 高级 OR 资深
site:lagou.com "数据仓库" OR "数据治理" 资深
site:liepin.com "AI Infra" OR "大模型" 北京 OR 上海
site:51job.com "数据平台" 高级
```

**注意：** `site:zhipin.com` 等返回的链接可能是登录墙，提取到 URL 但取不到 JD 是常态。把这种 URL 加进 pipeline.md 标 `[!]`，等人工处理。

**优先级：**
1. Level 1：Playwright → 所有 `tracked_companies` 中 `enabled: true` 且有 `careers_url` 的公司
2. Level 3：WebSearch → 所有 `enabled: true` 的 search_queries

各层结果合并 + 去重。

## Workflow

1. **读配置：** `portals.yml`
2. **读历史：** `data/scan-history.tsv` → 已见过的 URL
3. **读去重源：** `data/applications.md` + `data/pipeline.md`

4. **Level 1 — Playwright 扫描**（每批 3-5 并行）：
   对 `tracked_companies` 中 `enabled: true` 且有 `careers_url` 的每个公司：
   a. `browser_navigate` 到 `careers_url`
   b. `browser_snapshot` 读所有 job listing
   c. 如果页面有筛选/部门，进入相关分类
   d. 每个 listing 提取：`{title, url, company}`
   e. 如果有翻页，遍历下一页
   f. 累积候选列表
   g. 如果 `careers_url` 失败（404/重定向），尝试 `scan_query` fallback，并标记需更新

5. **Level 3 — WebSearch queries**（可并行）：
   对 `enabled: true` 的每个 query：
   a. WebSearch 执行 `query`
   b. 每个结果提取 `{title, url, company}`
   c. 累积候选列表（与 Level 1 去重）

6. **按 title 过滤** 用 `portals.yml` 的 `title_filter`：
   - 至少 1 个 `positive` 关键词命中（不区分大小写）
   - 0 个 `negative` 命中
   - `seniority_boost` 命中加权但非强制

7. **三重去重：**
   - `scan-history.tsv` → URL 已见过
   - `applications.md` → 公司+岗位归一化后已评估
   - `pipeline.md` → URL 已在待办或已处理

8. **每个新岗位通过过滤后：**
   a. 加进 `pipeline.md` "待处理" 段：`- [ ] {url} | {company} | {title}`
   b. 写入 `scan-history.tsv`：`{url}\t{date}\t{query_name}\t{title}\t{company}\tadded`

9. **被过滤的：** `scan-history.tsv` 标 `skipped_title`
10. **重复的：** 标 `skipped_dup`
11. **登录墙抓不到的：** 标 `needs_manual` 并加进 pipeline.md 用 `[!]` 标

## title 提取（中文 JD）

中文搜索结果常见格式：
- `"高级数据开发工程师 - 字节跳动 - 北京"`
- `"数据仓库专家 | 阿里巴巴"`
- `"大模型算法工程师 @ DeepSeek"`
- `"Senior Data Engineer at PingCAP"`

通用正则：`(.+?)(?:\s*[-—|@/]\s*|\s+at\s+|\s+在\s+)(.+?)$`

**注意：** 中文岗位名常见关键词包括「专家」「资深」「高级」「负责人」「架构师」「leader」「TL」 — 这些都应该进 `seniority_boost`。

## 私链 / 抓不到的 JD

如果遇到无法公开访问的 URL：
1. 标 `[!]` 在 pipeline.md
2. 让候选人手动贴 JD 文本到 `jds/{company}-{role-slug}.md`
3. 在 pipeline.md 引用：`- [ ] local:jds/{company}-{role-slug}.md | {company} | {title}`

## scan history

`data/scan-history.tsv` 记录所有见过的 URL：

```
url	first_seen	portal	title	company	status
https://...	2026-04-07	字节跳动 careers	数据工程师	字节跳动	added
https://...	2026-04-07	Boss直聘 query	Java	某公司	skipped_title
https://...	2026-04-07	Lagou query	数据	某公司	needs_manual
```

## 输出摘要

```
门户扫描 — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━
Query 执行：N
找到岗位：N 总
title 过滤后：N 相关
重复：N（已评估或已在 pipeline）
登录墙/抓不到：N（标 [!] 待人工）
新加入 pipeline.md：N

  + {公司} | {岗位} | {来源}
  ...

→ 跑 /career-ops pipeline 评估这些新岗位。
```

## careers_url 维护

每个 `tracked_companies` 都需要一个 `careers_url` — 否则每次扫描都要重新搜。

**查不到 careers_url 时：**
1. 试已知公司的常见 URL pattern
2. 失败就 WebSearch：`"{公司}" careers OR 招聘 OR 加入我们`
3. 用 Playwright 验证打开
4. **找到了一定要写回 portals.yml**

**careers_url 返回 404 或跳转时：**
1. 在输出摘要里标记
2. 用 scan_query 做 fallback
3. 标记需要人工更新

## portals.yml 维护原则

- **新加公司必填 `careers_url`**
- 发现新门户/新公司就加进来
- 噪音太大的 query 用 `enabled: false` 关掉
- 关键词过滤随你的目标方向演化而调整
- 想长期跟踪的公司加进 `tracked_companies`
- 定期检查 `careers_url` — 公司换 ATS 是常事
