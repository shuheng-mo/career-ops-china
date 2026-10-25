# 与上游的关系

本项目 fork 自 [`santifer/career-ops`](https://github.com/santifer/career-ops)，完整保留 MIT License 和原作者版权。

## 保留了什么

- 设计思想：做过滤器不做海投、人在回路是特性而不是缺陷、agent 式评估
- 基础设施：mode 框架、A-F 六块结构、TSV → tracker 的合并流程、评分矩阵、batch worker 架构
- 工具链：Node.js、Playwright、Markdown、YAML

## 替换了什么

| 区域 | 改动 | 文件 |
|---|---|---|
| Mode | 全部中文重写，按国内招聘流程调整；新增 `inbox`、`story-sync`、`radar`、`feishu` | `modes/` |
| Archetype | 换成数据 / 大模型 / AI Infra / 后端 / 平台方向 | `modes/_profile.template.md` |
| 薪资调研 | 看准网 / 脉脉 / OfferShow / 知乎 / 一亩三分地 / leetcode.cn | `modes/offer.md` |
| 公司调研 | 脉脉职言区 / 天眼查 / 企查查 / IT 桔子 / 36 氪 / 小红书 | `modes/deep.md` |
| 评分 | 薪资 / 工时 / 稳定性提权，去掉远程质量 | `modes/_shared.md` |
| 触达 | LinkedIn → 脉脉 + 微信 + Boss | `modes/contact.md` |
| 申请表 | 国内特有问题（婚育 / 加班 / 学历认证 / 到岗时间） | `modes/apply.md` |
| 简历 | Markdown 源 → PDF（`npm run cv`），纯黑排版，中文字体回退 | `tools/cv-md-to-pdf.mjs`、`modes/pdf.md` |
| 门户 | 预置 50+ 家中国公司 | `templates/portals-china.example.yml` |
| 状态 | 英文 canonical + 中文别名（已评估 / 已投递 / 面试中 …），新增 `Blocked` | `templates/states.yml` |
| 规则 | 加入国内求职特殊提醒 | `CLAUDE.md` |

## 新增了什么

- **Bookmarklet + 本地 inbox**：国内反爬平台的取数方案（[JD-CAPTURE.md](JD-CAPTURE.md)）
- **接口取数**：神仙外企、腾讯 careers、LinkedIn 免登录接口，以及投递链接存活校验
- **飞书集成**：多维表格 tracker 后端、跟进任务、面试日程、投递脉搏、面试复盘表、漏斗看板、每日摘要（[FEISHU.md](FEISHU.md)）
- **Tracker 抽象层**：`tools/tracker-backend.mjs`，md 与多维表格两个后端对上层透明
- **多方向 Track** 与证据闸门
- **简历事实校验**：`npm run sync-check`
- 修复上游脚本在路径含空格时的 bug

上游的 Go TUI 看板已归档到 `attic-dashboard/`（原因见其中的 `WHY-ARCHIVED.md`），由飞书多维表格的看板视图取代。

## 从上游同步

```bash
git remote add upstream https://github.com/santifer/career-ops.git   # 只需一次
git fetch upstream
git merge upstream/main     # 改动面很大，冲突需要逐个解决
```

---

## 目录结构

```
career-ops-china/
├── README.md / CLAUDE.md / LICENSE
├── cv.md, cv-<track>.md            # ⛔ gitignored：简历事实层 / 各方向改写层
├── article-digest.md               # ⛔ gitignored：作品证据（可选）
├── portals.yml                     # ⛔ gitignored：你定制的门户
│
├── config/
│   ├── profile.example.yml         # 模板
│   ├── target_pool.template.md     # 目标公司分层模板
│   ├── profile.yml                 # ⛔ 个人配置
│   └── target_pool.md              # ⛔ 你的公司池
│
├── modes/                          # 每个命令一个 markdown
│   ├── _shared.md                  # 全局规则、评分、数据源、职级对标
│   ├── _profile.template.md        # archetype / Track 模板
│   ├── _profile.md                 # ⛔ 你的 archetype、叙事、谈判策略
│   └── auto-pipeline.md, offer.md, inbox.md, scan.md, feishu.md, …
│
├── templates/
│   ├── portals-china.example.yml   # 50+ 中国公司预置
│   ├── states.yml                  # canonical 状态 + 中文别名
│   └── cv-template.html            # 遗留 HTML 简历模板
│
├── tools/
│   ├── tracker-backend.mjs         # tracker 统一 API
│   ├── backends/                   # md / bitable 实现
│   ├── feishu/                     # 飞书插件层（capabilities 是唯一的 lark-cli 出口）
│   ├── bookmarklets/               # 6 个 bookmarklet 源码
│   ├── jd-inbox-server.mjs         # localhost:8787
│   ├── waiqi-scan.mjs, tencent-careers.mjs, linkedin-jobs.mjs, apply-link.mjs
│   ├── cv-md-to-pdf.mjs, cv-sync-check.mjs
│   ├── merge-tracker.mjs, verify-pipeline.mjs, dedup-tracker.mjs, normalize-statuses.mjs
│   └── setup-bitable-tracker.mjs, migrate-…, sync-md-from-bitable.mjs, backfill-…
│
├── batch/                          # batch-prompt.md + runner；其余 gitignored
├── data/                           # ⛔ tracker / pipeline / scan 历史
├── inbox/                          # ⛔ 抓到的 JD JSON，processed/ 归档
├── reports/ output/ jds/ outreach/ # ⛔ 报告、生成的简历、JD、触达记录
├── interview-prep/                 # ⛔ story-bank.md
├── docs/                           # 本目录
└── attic-dashboard/                # 已归档的 Go TUI
```
