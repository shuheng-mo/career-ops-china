# JD 取数

国内招聘门户和海外差异很大。这个 fork **放弃了对国内反爬平台的自动化抓取**：Playwright / WebFetch 在 Boss、Mokahr、飞书表单上基本拿不到 JD，硬撑只会拖慢整个会话。取而代之的是三条路：

1. **你已经打开的页面** → bookmarklet 一键送进本地 inbox
2. **有公开 JSON 接口的站点** → 脚本直接读接口
3. **完全公开的静态页** → WebFetch

---

## 各平台的策略

| 平台 | 问题 | 处理方式 |
|---|---|---|
| V2EX 招聘 / GitHub README / 公司自有静态 careers 页 | 公开无限制 | WebFetch 直接读 |
| 大厂 careers SPA（字节 / 阿里 / 美团 / 网易 / 小红书 / B 站等） | 详情页是 SPA 空壳 | `dachang-spa` bookmarklet，或截图 |
| 腾讯 careers | SPA，但背后是公开 JSON 接口 | `npm run tencent` |
| AI 独角兽 careers（Mokahr / 飞书表单） | iframe / 表单 | `mokahr` bookmarklet，或截图 |
| Boss 直聘 / 拉勾 / 猎聘 | 反爬 + 滑块 + 登录墙 + 反复制 | 对应站点的 bookmarklet |
| 神仙外企（waiqi.com） | Vue SPA，背后是免登录 JSON 接口 | `npm run waiqi` |
| LinkedIn（cn.linkedin.com） | 未登录时 JD 被折叠 | `npm run linkedin`（走 LinkedIn 自己的免登录接口） |
| 脉脉招聘 / 微信公众号 | 必须登录 / DOM 加密 | 截图发给 Claude |

---

## Bookmarklet + 本地 Inbox

### 原理

反爬拦的是复制和脚本化访问，但**你在浏览器里已经看到的 JD，页面上的 JS 一直能读到 DOM**。一个 bookmarklet 就能：

1. 去掉反复制的 CSS 和事件处理
2. 用站点专用的选择器结构化抽取 `job_title` / `company` / `salary` / `description`
3. POST 到 `localhost:8787` 的本地服务
4. 服务写入 `inbox/*.json`
5. 你运行 `/career-ops inbox`，Claude 批量评估

### 6 个 bookmarklet

| Bookmarklet | 适用页面 |
|---|---|
| `universal` | V2EX / GitHub / 公司自有 careers 静态页，覆盖大多数场景 |
| `boss-zhipin` | `zhipin.com` 详情页（去反复制 + 结构化字段） |
| `liepin` | `liepin.com` 详情页 |
| `lagou` | `lagou.com` 详情页 |
| `mokahr` | `mokahr.com` / `app.mokahr.com` |
| `dachang-spa` | 字节 / 阿里 / 蚂蚁 / 腾讯 / 美团 / 快手 / 小红书 / B 站 / 网易 / 京东 / 拼多多 / 百度 / 滴滴 / 智谱 / MiniMax / 阶跃 / 面壁 等 |

源码在 `tools/bookmarklets/`。

### 一次性安装（约 5 分钟）

```bash
npm run inbox-server          # 1. 启动本地 inbox 服务（保持运行）
npm run build-bookmarklets    # 2. 生成安装页
open tools/install.html       # 3. 在浏览器打开
# 4. 显示书签栏（⌘+Shift+B），把彩色按钮拖进去
```

### 日常使用（每个 JD 约 5 秒）

```
打开 JD 页 → 点对应 bookmarklet → 看到「✓ JD captured」→ 攒几个 → /career-ops inbox
```

inbox 处理完后，所有分拣过的 JSON（包括判为 SKIP / Discarded 的）都会移到 `inbox/processed/`，保证 inbox 清零。

### 安全

- 服务只监听 `127.0.0.1`
- `inbox/*.json` 只存在本地，已 gitignore
- bookmarklet 不会把数据发给 Claude / Anthropic / 任何第三方，只发到你本机

更多细节（后台运行、调试、新增站点）见 [`tools/README.md`](../tools/README.md)。

---

## 接口取数脚本

这些站点背后都是公开、免登录的 JSON 接口，没什么可「爬」的。脚本一次只发一个请求，带间隔，读的是你本来也会手动打开的岗位。

### 神仙外企

```bash
npm run waiqi                              # 全量：列表 → 过滤 → 去重 → 拉 JD → 写 inbox
npm run waiqi -- --since 2026-10-18        # 只看该日期之后更新的岗位
npm run waiqi -- --categories IT技术,供应链 # 只扫指定职位类别
npm run waiqi -- --max-pages 30            # 列表请求次数上限
npm run waiqi -- --dry-run                 # 只统计，不写 inbox
```

神仙外企只作为线索源：写入的 JSON 里 `url` 是校验过的企业官网投递链接，官网已下线的岗位不会落盘。标题过滤与 scan 用同一套规则（`tools/title-filter.mjs`，读 `portals.yml`）。

### 腾讯 careers

```bash
npm run tencent -- "<careers.tencent.com/search.html?... 的 URL>" [--days 30] [--fetch]
npm run tencent -- agent --city 上海,深圳 [--days 30] [--fetch]
```

不带 `--fetch` 只列出岗位，带上则把完整职责和要求写进 inbox。已经在 inbox 或 processed 里的会跳过。

### LinkedIn

```bash
npm run linkedin -- <岗位链接 | 岗位 ID> [...]
npm run linkedin -- search "<关键词>" [--city 上海] [--days 7] [--pages 2] [--fetch]
```

刻意保持低频：一次一个请求、间隔约 1.5 秒、每次搜索最多 5 页。搜索页链接（`/jobs/search?…`，常带 `trk=missing_jd_redirect`）说明原岗位已下线。

### 投递链接存活校验

```bash
npm run apply-link -- <url>
npm run apply-link -- inbox/processed/jd-*.json
```

线索平台转载的官网链接不保证时效。按 ATS 分别处理：

| ATS | 判断方式 |
|---|---|
| Workday | 公开接口：200 在招，403 / 404 / 410 已下线 |
| SmartRecruiters | 公开接口：200 在招，4xx 已下线 |
| 其他 | 404 / 410 或页面出现「已下线」类文案 → 已下线；否则标 `unverified`（SPA 壳页 HTTP 200 不代表岗位还在） |

有任一 `closed` 时退出码为 2，方便脚本判断。

---

## scan：只做线索发现

`/career-ops scan` 只负责发现「有哪些岗位在招」（URL + 标题），**不承诺拿到 JD**：

1. 按 `portals.yml` 里启用的 `search_queries` 低频搜索
2. 读 `tracked_companies` 的 careers 列表页（仅标题和链接）
3. 用 `title_filter` 和 `deal_breakers` 过滤
4. 与 scan 历史、tracker、pipeline 三重去重
5. 写入 `data/pipeline.md`，带优先级和取 JD 的方式提示

JD 内容之后用 bookmarklet、接口脚本或截图获取。

`/career-ops radar` 可以配置云端定期运行的「线索雷达」：每隔几天自动搜索目标城市和方向的新岗位，只输出线索清单。云端拿不到你的本地文件和浏览器，所以它不评估、不写 tracker。

## 遗留：scan-helper

`tools/scan-helper.mjs` 是更早为国内 SPA 写的 Playwright 桥，现在基本被 bookmarklet 取代，只保留给完全公开的 careers 列表页和离线脚本：

```bash
node tools/scan-helper.mjs <URL> [--mode=jd|list] [--wait=5000]
```

不要用 `--user-data-dir` 复用你的日常 Chrome profile。bookmarklet 是你自己触发的操作，不会触发反爬，比 Playwright 稳定。
