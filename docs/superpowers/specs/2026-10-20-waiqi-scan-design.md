# waiqi-scan 设计文档 — 神仙外企岗位抓取工具

日期：2026-10-20
状态：已获用户批准（方案 A）

## 背景

用户在用 www.waiqi.com/position（神仙外企，外企官方渠道招聘信息聚合站）找岗位。
该站是 Vue SPA，数据来自两个**无需登录**的公开 JSON 接口（已于 2026-10-20 实测）：

- 列表：`POST https://backservice.offerxiansheng.com/api/position-service/social-position/foreign/page-list`
  - 请求体：`{page, size, keyword, categoryIdList, companyTypeList, sort, type:2, cityIds, posIds, status:1}`
  - 实测 `{"page":1,"size":20,"keyword":"","categoryIdList":[],"companyTypeList":[],"sort":0,"type":2,"cityIds":"","posIds":"","status":1}` 返回 `code:1000`，当前共 1040 个岗位
- 详情：`GET https://backservice.offerxiansheng.com/api/position-service/social-position/details?id={id}`
  - 返回 `description` 字段为 JD 全文（公司官方 JD），无需会员

会员墙挡住的是联系方式 / 投递入口，不影响 JD 内容。本工具只读公开列表 + JD 数据，手动低频运行，礼貌节流 ~2 req/s。

## 目标

把 waiqi 上匹配候选人方向的岗位**连 JD 全文一起**拉进现有求职系统，以 inbox JSON 形式落盘，
由现有 `/career-ops inbox` 流水线消化（triage → auto-pipeline 评估 → tracker）。

非目标：不抓联系方式、不自动投递、不做定时调度（手动按需运行）。

## 方案选择

| 方案 | 结论 |
|------|------|
| A. 纯 API 直抓 CLI | ✅ 采用。快、稳、无反爬 |
| B. Playwright 抓页面 | ❌ 接口是裸 JSON，浏览器渲染无必要 |
| C. 并入 scan 模式 | ❌ scan 是「只发现线索」范式，waiqi 能给 JD 全文，塞进去互相委屈；独立工具后续想并再并 |

## 组件设计

### 1. `tools/title-filter.mjs`（新，提取复用）

从 `tools/test-title-filter.mjs` 提取可复用的 track-scoped 过滤逻辑：
- `loadTitleFilter(roots)` — 读 portals.yml（fallback `templates/portals-china.example.yml`），返回 `{globalNeg, tracks}`
- `judgeTitle(title, filter)` — 返回 `{keep, why, matchedTracks}`，判定顺序固定：
  1. 命中全局 `negative` 任意一条 → drop
  2. 对每个 track：命中其 `positive` ≥1 且未命中其 `negative` → keep，打 track 标签
  3. 无任何 track 命中 → drop
- 大小写不敏感子串匹配（外企岗位标题多为英文，必须与现有行为一致）

`tools/test-title-filter.mjs` 改为 import 该模块，回归测试必须继续全绿（保证提取不改行为）。

### 2. `tools/waiqi-scan.mjs`（新，主工具）

CLI：`node tools/waiqi-scan.mjs [--max-pages N] [--dry-run] [--since YYYY-MM-DD]`
同时挂 `npm run waiqi`。

流程：

1. **拉列表**：翻页请求 page-list（size=20，页间 sleep 500ms），直到最后一页或 `--max-pages`
2. **时间过滤**（可选 `--since`）：只保留 `updateTime >= since` 的岗位
3. **标题过滤**：用 `title-filter.mjs` 判定；drop 的写 scan-history `skipped_title_filter`（备注命中/未命中词）
4. **去重**（对 keep 的岗位）：
   - `data/scan-history.tsv` 已见 URL → `skipped_dup`
   - `data/applications.md` 已存在同公司+岗位 → `skipped_dup`
   - `data/pipeline.md` 已有该 URL → `skipped_dup`
5. **拉详情**：仅对通过 3+4 的岗位请求 details（sleep 500ms），取 `description` 全文
6. **落盘 inbox**：`inbox/jd-{YYYYMMDDHHmmss}-waiqi-{岗位名slug}.json`，schema 与 bookmarklet 一致：
   ```json
   {
     "url": "https://www.waiqi.com/position/detail?id={id}",
     "page_title": "{岗位名}_{公司名}_神仙外企",
     "captured_at": "ISO-8601",
     "platform": "waiqi",
     "extracted": {
       "job_title": "...", "company": "...", "salary": "...(可空)",
       "location": "...", "seniority_experience": "...",
       "description": "JD 全文", "requirements": "", "raw_text": ""
     }
   }
   ```
7. **写 scan-history.tsv**：所有见过的岗位一行：`{url}\t{first_seen}\twaiqi\t{title}\t{company}\t{status}`
8. **输出摘要**：拉取数 / 标题过滤后 / 去重后新增 / 各 track 命中分布 / inbox 新文件清单，
   末尾提示用户跑 `/career-ops inbox`

### 3. 字段映射注意

- `salary`：列表常为空，取详情 `salaryMin/salaryMax`，`negotiable=1` 时写「面议」；都没有则留空
- `location`：`cityNameList`（可能多城，顿号连接）
- `seniority_experience`：详情 `workExpName`；学历 `educationName` 并入该字段（如「1-3年 · 本科」）
- `description` 为空或 < 100 字：仍落盘但摘要里标 ⚠️（inbox mode 会对 raw_text 过短的跳过，正好兜底）

## 错误处理

- 列表/详情请求失败：重试 2 次（指数退避 1s/2s），仍失败则记录并跳过该页/该岗位，不中断整体
- 详情 `code != 1000`：跳过该岗位，摘要中计数
- `inbox/` 写入文件名冲突：追加 `-{id}` 保证唯一
- portals.yml 缺失：fallback 模板 + 警告（与 test-title-filter 一致）

## 测试

- 现有：`node tools/test-title-filter.mjs` 必须在提取后全绿
- 新工具验证：`--dry-run --max-pages 2` 冒烟（只拉 2 页，不写文件，打印过滤/去重统计）；
  再实跑一次确认 inbox JSON 格式被 `modes/inbox.md` 的 schema 接受
- 项目无 JS 单测框架，不新增测试脚手架；以 test-title-filter 回归 + 冒烟为准

## 边界与伦理

- 只读公开接口，手动低频运行（预计几天一次），请求节流 ~2 req/s
- 不抓取/不绕过会员内容（联系方式、投递入口）
- 与 CLAUDE.md「不推荐爬虫式扫描 Boss/拉勾/猎聘」不冲突：该限制针对反爬严苛平台；
  waiqi 为公开 JSON API 且本工具低频只读
- 抓到的岗位永远先过 inbox triage + 用户确认，不会自动投递
