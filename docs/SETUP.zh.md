# 安装与配置

## 前置

- [Claude Code](https://claude.ai/code)
- Node.js 18+
- （可选）[lark-cli](https://github.com/larksuite/lark-cli)：只有接飞书时才需要，见 [FEISHU.md](FEISHU.md)

## 安装

```bash
# 1. clone
git clone https://github.com/shuheng-mo/career-ops-china.git
cd career-ops-china

# 2. 依赖（只有 playwright）
npm install

# 3. Chromium，用于生成 PDF
npx playwright install chromium

# 4. 复制配置模板
cp config/profile.example.yml config/profile.yml
cp templates/portals-china.example.yml portals.yml

# 5. 启动 Claude Code
claude
```

`modes/_profile.md` 和 `config/target_pool.md` 不需要手动建：Claude 每次会话开始时如果发现缺失，会从对应的 `.template.md` 复制一份。

## 让 Claude 帮你 onboarding

在 Claude Code 里说：

> 帮我配置 career-ops-china

它会按 `CLAUDE.md` 的流程一步步来：

1. **简历**：贴文本、给主页链接或口述经历都行，它整理成 `cv.md`
2. **基本信息**：base 城市、能否搬迁、目标岗位、期望薪资、当前状态，写进 `config/profile.yml`
3. **目标公司**：`portals.yml` 已预置 50+ 家，问你要加哪些、去掉哪些
4. **Tracker**：没有 `data/applications.md` 就建一个
5. **了解你**：你的独特优势、什么工作让你兴奋或疲惫、deal-breaker、最自豪的项目、公开作品。**给的上下文越多，过滤越准**

之后每次评估，如果你说「这个分太高了，我不会投」或「你漏了我有 X 经验」，它会更新 `_profile.md` 或 `profile.yml`，下次更准。

---

## cv.md 怎么写

`cv.md` 是简历的事实来源，所有评估和 PDF 都从它读。已 gitignore，可以放心写个人信息。

推荐结构（国内简历惯例）：

```markdown
# 姓名 — 目标岗位

## 个人信息
- 手机 + 邮箱（简历 PDF 页眉第一项必须是手机号，构建时从这里读，缺失会报错）
- 当前 base 城市
- GitHub / 博客等

## 教育背景
时间 | 学校 | 专业 | 学位

## 工作经历
按时间倒序：公司 + 职位 + 时间 + 一行总结

## 项目经历
### YYYY.MM-YYYY.MM｜公司 — 项目名｜你的角色
**项目背景与目标**：业务背景 + 目标
**我的职责**：1. 2. 3.
**业绩**：量化结果（QPS / p99 / 准确率 / 降本 / 用户量等）

## 技术能力
按类别分组：编程语言 / AI 大模型 / 数据 / 后端 / DevOps

## 获奖与证书
```

国内 HR 看项目细节往往多于看职级，项目经历值得写细。

多个求职方向时，可以为每个方向准备一份 `cv-<track>.md` 改写版，规则见 [EVALUATION.md](EVALUATION.md#简历事实层与改写层)。

## config/profile.yml 怎么写

身份和偏好的配置文件，已 gitignore。关键字段：

```yaml
candidate:
  full_name: "你的姓名"
  email: "you@example.com"
  location: "杭州"
  willing_to_relocate: true
  preferred_cities: ["杭州", "上海"]

target_roles:
  primary:
    - "大模型应用工程师 / LLM Engineer"
  archetypes:
    - name: "大模型应用工程师 / LLM Engineer"
      level: "中高级"
      fit: "primary"

narrative:
  headline: "一句话定位"
  exit_story: "为什么找新工作、想往哪个方向走"
  superpowers: ["...", "..."]
  proof_points:
    - name: "项目名"
      hero_metrics: ["指标 1", "指标 2"]

compensation:
  target_range: "..."
  walk_away_minimum: "..."

deal_breakers:                 # 硬红线，命中直接 SKIP
  - "..."
strong_preferences_against:    # 强烈不偏好，但不是绝对红线
  - "..."

tracker:
  backend: md                  # md | bitable，见 FEISHU.md

feishu:
  enabled: false               # 见 FEISHU.md
```

完整示例见 [`config/profile.example.yml`](../config/profile.example.yml)。

## portals.yml 怎么改

```yaml
title_filter:
  positive: ["大模型", "Agent", "数据工程"]   # 想要的岗位关键词
  negative: ["实习", "校招", "派遣"]          # 不要的岗位关键词

search_queries:
  - name: 某方向
    query: '"大模型应用" 高级 OR 资深'
    enabled: true

tracked_companies:
  - name: 字节跳动
    careers_url: https://jobs.bytedance.com/experienced/position
    enabled: true
```

预置 50+ 家：一线互联网大厂、大模型独角兽、数据基础设施创业公司、AI Infra 公司。

WebSearch 的 `site:` 只对顶级域名可靠：`site:v2ex.com/go/jobs` 这种深路径、`site:A OR site:B` 这种多站点组合经常返回 0 条，改用「顶级域名 + 关键词」。

---

## 隐私

以下文件都已 gitignore，不会被提交：

| 文件 | 内容 |
|---|---|
| `cv.md`、`cv-*.md`、`article-digest.md` | 简历和作品证据 |
| `config/profile.yml`、`config/target_pool.md`、`modes/_profile.md` | 个人档案、目标公司池、archetype 与叙事 |
| `portals.yml` | 你定制的门户配置 |
| `data/applications.md`、`pipeline.md`、`scan-history.tsv`、`reminders.md`、`followup-tasks.json` | 投递追踪与历史 |
| `reports/`、`output/`、`jds/`、`inbox/`、`outreach/` | 评估报告、生成的简历、JD、触达记录 |
| `interview-prep/story-bank.md` | 面试故事库 |

**触达消息和聊天草稿里不会写手机号**（`modes/_shared.md` 全局规则）。简历 PDF 是例外：页眉必须有手机号。

如果你也把自己的 fork 公开，提交前扫一遍：个人信息只应该出现在 gitignore 的文件里。
