# Mode: scan — 招聘线索发现器（中国大陆版）

> **⚠️ 重要范式变更（2026-04 重写）**
>
> **scan 是「线索发现」工具，不是「JD 提取」工具。**
>
> 国内主流平台（Boss直聘 / 拉勾 / 猎聘 / 脉脉 / Mokahr / 飞书表单）有**严苛的反爬 + 反复制 + 登录墙 + SPA**，自动化提取 JD 在 99% 场景下不可行，硬撑只会浪费时间。
>
> scan 的现实定位：
> 1. ✅ 发现"哪些公司在招"、"岗位标题大致是什么"、"在哪个 URL"
> 2. ❌ **不**承诺取到 JD 全文
> 3. ✅ 把发现的 URL 列表交给用户，**用户用截图/手动复制方式把 JD 给 Claude**

---

## 中国大陆推荐工作流（**主路径**）

```
┌──────────────────────────────────────────────────────────────┐
│ 用户日常发现岗位的 5 种方式（按推荐度排序）                 │
├──────────────────────────────────────────────────────────────┤
│ 1. 截图 JD → 拖到对话框 → /career-ops auto-pipeline          │
│    ✅ 覆盖率 100%（Boss/Mokahr/飞书/微信/脉脉 全适用）        │
│    ✅ 5 秒/岗位，零反爬风险                                  │
│                                                              │
│ 2. 复制 JD 全文 → 粘贴到对话框 → auto-pipeline                │
│    ✅ 适用于允许复制的网站（liepin 部分页 / V2EX / 知乎）    │
│                                                              │
│ 3. 邮件订阅（Boss/拉勾/猎聘 关键词推送）→ 邮箱里能看到 JD     │
│    → 用 lark-mail 或转发到 Claude                            │
│    ✅ 完全被动，每天自动流入                                 │
│                                                              │
│ 4. 内推贴 / 公众号 / V2EX → 完整 JD 公开                     │
│    → 复制 URL，auto-pipeline 通常能直接 WebFetch              │
│                                                              │
│ 5. /career-ops scan（本 mode）→ 仅获取 URL + 标题列表        │
│    → 用户对感兴趣的岗位用方式 1 / 2 取 JD                    │
│    ⚠️ 不要期待 scan 直接给你 JD                              │
└──────────────────────────────────────────────────────────────┘
```

**给 Claude 的核心规则：**
> 任何时候用户说「评估这个岗位」+ 给了 URL，**先尝试 WebFetch 一次**。如果失败（登录墙 / SPA / 反爬），**立即停止尝试自动化**，告诉用户：「这个 URL 抓不到 JD，请截图给我或复制 JD 文本」。**不要在国内门户上反复挣扎。**

---

## scan 实际能做什么

| 能 | 不能 |
|----|------|
| ✅ 用 Playwright 抓**大厂自有 careers 页**的岗位列表（标题 + URL，多数无登录） | ❌ 抓 Boss直聘 / 拉勾 / 猎聘 / Mokahr 的 JD 详情 |
| ✅ 用 WebSearch 在搜索引擎层面**发现**岗位 URL（`site:` 过滤） | ❌ 验证 Boss/拉勾的岗位是否还在招 |
| ✅ 监听公开渠道：V2EX 招聘版、GitHub 招聘 README、知乎招聘文章、公众号文章 URL | ❌ 抓取脉脉/微信公众号/飞书表单内容 |
| ✅ 把发现的 URL 写进 `pipeline.md`，标注是否需要人工取 JD（`[ ]` 可取 / `[!]` 需人工） | ❌ 替用户筛选 JD 内容（因为大部分时候根本抓不到） |
| ✅ 维护 `scan-history.tsv` 去重 | — |

---

## 配置

读 `portals.yml`：
- `scan_defaults` — token 节流开关（`scan_company_queries_enabled` / `dedup_window_days` / `interactive_confirm`）
- `search_queries` — WebSearch queries（广度发现），每条带 `priority: high|low`
- `tracked_companies` — 大厂直抓列表，每条带 `careers_url`，部分带 `scan_query`（公司级，默认不跑）
- `title_filter` — positive/negative/seniority_boost 关键词

**可选字段（2026-04-20 新增，仅作 metadata 用于分组 / selector 提示）：**
- `category: big_tech | ai_unicorn | ai_research | data_infra | mnc_china`
  - 用于将来 `scan --category=<name>` 子集过滤；目前 Claude 只用于输出摘要分组
- `ats: workday | greenhouse | smartrecruiters | mokahr | feishu | custom`
  - Mokahr / 飞书 通常需登录 → Claude 读到这两个值时应跳过 Playwright 改标 `[!]`
  - Workday / Greenhouse / SmartRecruiters 是公开 ATS，Playwright 可直抓，selector 模式相对稳定

**渠道扩容日志：** 新渠道清单维护在 `~/.claude/plans/scan-playwright-lively-meteor.md`（2026-04-20 +21 家公司 / +13 条 query；A1 AI 研究机构、A2 二线独角兽、A3 数据 Infra 多数 enabled=false 需抽样验证 URL 后再开；A4 外企在华公开 ATS 已默认 enabled=true）。

**⚠️ WebSearch query 写法约束（2026-04-20 首轮实测）：** 写新 `search_queries` 条目或改写现有 query 时必须遵守：

| 模式 | 能否工作 | 替代写法 |
|------|---------|---------|
| `site:X/deep/path keywords`（如 `site:v2ex.com/go/jobs`、`site:paperswithcode.com/jobs`）| ❌ 返回 0 | 去掉 site:，用"品牌名 子路径关键词 + 2026" 自然语言，如 `V2EX 招聘 数据工程 2026` |
| `site:A OR site:B keywords`（多站点 OR）| ❌ 返回 0 | 挑最强的一个 `site:`，或去掉 site: 全部 |
| `site:tld (A OR B)`（只用顶域 + OR 关键词组）| ✅ 可用 | 保留 |
| `品牌名/域名 + 关键词 + 2026`（纯自然语言）| ✅ 可用 | 保留 |

**规则：** 新建 query 前 mental check — 有 `site:` 且含深路径？改自然语言。有多 `site: OR site:`？拆或改自然语言。**不要直接 ship 未验证的 `site:` 精准 query**，会静默返回 0 条浪费 Phase 1 候选集位。

---

## 国内平台 — 实际表现速查

| 平台 | scan 能做 | 备注 |
|------|----------|------|
| **大厂自有 careers**（字节/阿里/腾讯/美团/快手/小红书/B站 等） | ✅ Playwright 抓岗位列表 OK | 详情页可能 SPA → 列表足够，详情让用户截图 |
| **AI 独角兽 careers**（DeepSeek/Moonshot/智谱/MiniMax 等） | ⚠️ 部分能抓，多数嵌入 Mokahr / 飞书表单 → 列表抓不完整 | 标题 + 入口 URL 给到用户，让用户自己进 |
| **Boss直聘** | ❌ 列表 + 详情都登录墙 | **不要尝试 Playwright**。WebSearch 只能拿到 URL + 标题片段，详情让用户截图 |
| **拉勾** | ⚠️ 列表偶尔可见，详情常需登录 | 同上 |
| **猎聘** | ⚠️ 列表可见，详情登录墙 | 同上 |
| **智联** | ⚠️ 反爬严，频率必须低 | 不推荐 |
| **51job** | ✅ 反爬较弱 | 可以试，但岗位质量一般 |
| **脉脉招聘** | ❌ 必须登录 | 不放进 scan |
| **V2EX 招聘版** | ✅ WebFetch JD 全文 | 内推贴的 JD 多数公开完整 |
| **GitHub 招聘 README**（如 `awesome-jobs`、各 AI 公司开源仓库的 hiring 段） | ✅ WebFetch | JD 全文公开 |
| **公众号文章** | ⚠️ 部分 URL 能 WebFetch（要看是否 mp.weixin） | 抓不到的让用户复制 |

---

## Workflow

### Phase 0 — 准备候选集（不耗 token，全是本地 I/O）

1. **读配置：** `portals.yml`（`scan_defaults` + `search_queries` + `tracked_companies` + `title_filter`）
2. **读历史：** `data/scan-history.tsv` → 已见过的 URL + **每个 query 最近执行时间**
3. **读去重源：** `data/applications.md` + `data/pipeline.md`

4. **事前去重（query 级，最近 N 天内跑过就跳过）：**
   - 窗口：`scan_defaults.dedup_window_days`（默认 7 天）
   - 扫 `scan-history.tsv` 找每个 `query name` 最后一次 `first_seen` 的日期
   - 如果距今 < N 天 → 该 query 标记 `skipped_recent_run`，**不进候选集**
   - 这一步在 WebSearch 之前做，直接省下大头 token

5. **构建候选清单：**
   - 全局 `search_queries` 中 `enabled: true` 且未被事前去重跳过的 → 按 `priority` 分 `high` / `low`
   - `tracked_companies` 中 `enabled: true` 且有 `careers_url` → 加入 `careers_scan` 组
   - 公司级 `scan_query`（`tracked_companies[*].scan_query`）：**仅当** `scan_defaults.scan_company_queries_enabled: true` 才并入，否则忽略

### Phase 1 — 交互式确认（强制，除非 `scan_defaults.interactive_confirm: false`）

在任何 WebSearch / Playwright 调用**之前**，先输出如下摘要让用户选：

```
scan 候选集 — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WebSearch query：
  🔴 high priority：N 条（强烈推荐）
  🟡 low priority ：M 条（补充面）
  ⏸ 跳过（7 天内已跑）：K 条
公司 careers 直抓：C 家（Playwright snapshot）
公司级 scan_query：X 条 {若全局开关关闭则写"(已跳过，开关关闭)"}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
预估工具调用：约 {N_high} ~ {N_high+N_low+C} 次
预估输入 token：~ {估算值}（high only 模式） / ~ {更大的估算} （全跑）

请选择：
  [h] 仅跑 high priority（推荐，最省 token）
  [y] 全跑（high + low）
  [c] 仅跑 careers 直抓，跳过 WebSearch
  [n] 取消
```

**等用户明确选择后**再进入 Phase 2。**不要假设用户想全跑**。

### Phase 2 — 执行（按用户选择的范围）

**Level 1 — Playwright 扫描大厂 careers**（用户选了 `y` / `h` / `c` 时执行；`n` 跳过）
对候选的 tracked_companies：
- `browser_navigate` 到 `careers_url`
- `browser_snapshot` 读所有 job listing
- 提取 `{title, url, company}`
- **不尝试**进每个详情页（详情往往是 SPA 壳，浪费时间）
- 翻页累积候选（首页 + 至多第 2 页；再翻就停）

**Level 3 — WebSearch 广度发现**（用户选了 `y` 跑全部 / `h` 仅跑 high；`c` / `n` 跳过）
对候选 query：
- WebSearch 执行（串行，不要并行 — 便于观察 token 消耗）
- 提取 `{title, url, company}`
- **不尝试** WebFetch Boss/拉勾/猎聘/脉脉详情页

### Phase 3 — 过滤 + 写入

6. **过滤** 用 `portals.yml` 的 `title_filter`：positive 命中 + negative 排除

7. **去重**（三重）：scan-history.tsv + applications.md + pipeline.md

8. **写入 pipeline.md**（**注意：不带 JD，只带 URL + 标题 + 来源标签**）：
   - 默认全部标 `[!]`（因为 99% 的 URL 取不到 JD）
   - 仅当来源是 V2EX / GitHub / 公司自有静态页 → 标 `[ ]`（可 WebFetch）
   - 标记格式：`- [!] {url} | {company} | {title} | {source} | 取 JD 方式：截图 / 复制`

9. **写入 scan-history.tsv**：所有看见的 URL 都进，`status=added/skipped_title/skipped_dup/needs_manual/skipped_recent_run`
   - **Query 级记录也要写** — 每个实际执行过的 query 写一行 `query_run\t{name}\t{timestamp}`，供下次事前去重读取

---

## 输出摘要（必须传递正确的预期）

```
门户线索发现 — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[资源消耗]
  WebSearch 次数：N
  Playwright snapshot 次数：M
  事前去重跳过（7 天内已跑）：K
  用户选择模式：{h / y / c}

[发现]
扫描公司 careers：C
执行 WebSearch query：Q
发现候选 URL：N
title 过滤后：N
去重后新增：N

按"取 JD 方式"分类：
  📄 可直接 WebFetch（V2EX/GitHub/公众号公开页）：N → 标 [ ]
  📸 需用户截图（Boss/Mokahr/飞书/SPA 详情）：N → 标 [!]
  📋 需用户复制（liepin/拉勾/部分 careers）：N → 标 [!]

新加入 pipeline.md：N
  + {公司} | {岗位} | 来源 {portal} | 取 JD：{截图/复制/可抓}
  ...

▼ 下一步（强烈推荐）：
  对每个感兴趣的岗位：
  1. 打开 URL → Cmd+Shift+4 截图 JD 区域
  2. 拖到对话框 → /career-ops（auto-pipeline 自动跑）
  
  千万不要等 scan 给你 JD — 它给不了。
```

**把 `[资源消耗]` 段放在最上面，让用户每次都看到本次 token 代价。**

---

## 私链 / 完全无 URL 的岗位

如果用户在脉脉私聊 / 微信群 / 内部转发里收到 JD：
1. 用户截图或粘贴 JD → 直接 auto-pipeline
2. 不需要写进 pipeline.md 的"待办"，直接处理掉

---

## scan history

`data/scan-history.tsv` 同时记录两类：

**（A）URL 级记录**（历史一直有的）：
```
url	first_seen	portal	title	company	status
https://...	2026-04-07	字节跳动 careers	数据工程师	字节跳动	added
https://...	2026-04-07	Boss直聘 query	Java	某公司	skipped_title
https://...	2026-04-07	Lagou query	数据	某公司	needs_manual
```

status 取值：`added` / `skipped_title` / `skipped_dup` / `needs_manual`

**（B）Query 级记录**（2026-04 新增，用于事前去重）：
```
query_run	{query_name}	{timestamp}	{priority}	{results_count}
query_run	Boss直聘 — 数据工程	2026-04-15T10:23	high	18
query_run	GitHub — 大模型公司招聘	2026-04-15T10:25	high	7
```

每次实际调用 WebSearch 的 query 都写一行。scan 启动时回读，`dedup_window_days` 内已跑过的 query 从候选集剔除。

`needs_manual` 表示已发现但需要用户手动取 JD（默认 99% 的国内门户结果都是这个状态）。

---

## careers_url 维护

每个 `tracked_companies` 都需要一个 `careers_url`。

**careers_url 失效时：**
1. 在输出摘要里标记
2. 不要做 fallback 自动重搜（浪费 token），直接告诉用户「这家的 careers_url 失效了，要不要更新？」让用户来决定
3. 用户给新 URL 后写回 portals.yml

---

## portals.yml 维护原则

- 新加公司必填 `careers_url`
- 噪音太大的 query 用 `enabled: false` 关掉
- 定期检查 `careers_url` — 公司换 ATS 是常事
- **不要再添加纯 Boss/拉勾 search query**（除非真有必要 + 用户能手动跟进）— 反正取不到 JD
- 新加的 query 默认标 `priority: low`；只有实测命中率 > 50% 才提升到 `high`
- 公司级 `scan_query`（如 Manus 系、小创业公司）默认不跑；需要用户主动改 `scan_defaults.scan_company_queries_enabled: true` 才会纳入

---

## 为什么这么改（给后来者的设计说明）

旧版 scan 试图做 **"发现 + 提取 JD + 去重 + 评估准备"** 一条龙。在国内市场上，"提取 JD" 这一步**结构性失败率 > 90%**：

- Boss 直聘 / 拉勾 / 猎聘 详情页 = 登录墙
- DeepSeek / Moonshot / 阶跃 等独角兽 = Mokahr / 飞书表单
- 字节 / 美团 / 小红书 careers 详情 = SPA 空壳
- 脉脉 / 微信公众号 = 完全反爬

继续在这条路上挣扎只会**累死 Claude，挫败用户**。新版的核心理念：

1. **职责分离：** scan 只管"发现哪些岗位存在"。"取 JD"交给人（5 秒截图）+ Claude Vision（直接读图）。
2. **诚实预期：** 输出摘要明确告诉用户哪些 URL 抓得到、哪些抓不到、对应取 JD 方式是什么。
3. **零浪费：** 不在反爬战争里耗 Playwright/WebFetch。**抓不到立刻 yield 给用户。**
4. **大厂 careers 仍然有价值：** 字节/阿里/腾讯 等的 careers 列表页能抓，至少能告诉用户「这家最近在招什么方向」。
