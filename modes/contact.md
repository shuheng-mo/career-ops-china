# Mode: contact — 主动触达（Boss / 脉脉 / LinkedIn / 微信）

中国大陆主动触达和西方差异很大。**Boss 直聘** 是投递+触达一体的主渠道（直接和 HR 聊）；**脉脉** 是 warm outreach 主场（找 hiring manager / peer）；**LinkedIn** 适合外企/海外岗。

## 落盘约定（重要）

**所有触达消息必须写入 `outreach/` 文件夹**，不要只输出到对话里。候选人要直接复制到 Boss/脉脉/微信，code block 方便一键复制。

**文件名：** `{报告编号}-{公司slug}-{渠道}-{日期}.md`
- 编号对齐 `reports/` 里对应的评估报告（让 outreach ↔ report 可互相追溯）
- 渠道用 `boss` / `maimai` / `linkedin` / `wechat`
- 示例：`outreach/026-topquant-boss-2026-04-15.md`

**文件结构模板：**
1. 头部元数据（日期 / 渠道 / 对应报告链接 / Score / 状态）
2. 渠道注意事项（Boss 500 字符限制、脉脉 5 行限制等）
3. 消息 1 / 2 / 3 — 每条包在 ` ```text ` code block 里方便复制
4. 投前准备清单（从 report F 段摘）
5. 发送记录表格（时间 / 消息 / HR 回复 / 备注）

发消息后，在发送记录表格里填时间和回复，不要额外开文件。

## 快捷语法：发送记录 → tracker 自动同步

**触发规则：** 在 outreach 文件 `## 发送记录` 表的 **"消息 1"** 这一行，**"时间"** 列填入 `YYYY-MM-DD` → 跑 `npm run sync-outreach` 会把 `data/applications.md` 里对应 # 的状态从 `Evaluated` 自动改为 `Applied`，并在 notes 里加上 outreach 文件引用。

**示例：**

```
| 时间       | 消息   | HR 回复 | 备注           |
| ---------- | ------ | ------- | -------------- |
| 2026-04-15 | 消息 1 | 待回复  | Boss 直聘已发 |  ← 时间填了 → 触发
|            | 消息 2 |         |                |
```

**何时跑：**
- 用户说「#XX 发了」/「投了」/「试一下同步」 → Claude 跑 `npm run sync-outreach`
- 也可以用户自己手动跑

**脚本规则（`tools/sync-outreach-status.mjs`）：**
- 不降级（如果状态已是 Applied/Responded/Interview/Offer/Rejected/Discarded/SKIP，不动）
- 幂等（重复跑不会重复改）
- HR 回复列**不自动解析**（自然语言太脆弱）。脚本只检测 HR 回复列非空，提示用户「可能要手动升 Responded/Interview」，由 Claude 询问后改

**HR 回复升级（手动路径）：**
- 用户在发送记录 HR 回复列填 "约一面"、"加微信了"、"拒了"
- 用户告诉 Claude：「#XX HR 回了」/「#XX 进面试了」
- Claude 根据 `templates/states.yml` aliases 直接 Edit applications.md

## Boss 直聘触达（国内求职主渠道）

Boss 是"投递+聊天"一体，HR 在 Boss 上就能直接过简历，和脉脉/LinkedIn 的 cold outreach 逻辑不同。

**Boss 触达的坑：**
1. **对接的主要是 HR，不是 hiring manager**。开场 30 秒要让 HR 看到"学历 + 项目 + 精准对位"，她才会转给技术 leader
2. **首条消息限约 500 字符**（≈200 汉字），超过截断 → 分 2-3 条发
3. **量化/金融/部分敏感公司会挂马甲**（如宽德投资挂"飞龙医疗"）—— 不要点破，按 JD 内容回应
4. **华为 OD / 外包标签不主动解释**，按 CV 如实写即可
5. **HR 回"方便发简历吗"→ 立刻发简历 + 追加一条"JD 对位补充"作为弹药**，方便 HR 转给技术 leader

**3 条消息框架（严格按此结构生成）：**
- **消息 1** — 首条打招呼（≤200 汉字）：钩子（对岗位方向的精准理解）+ 2 个 hero project + 指标 + 学历/开源
- **消息 2** — HR 要简历后追发：3-4 条 JD 对位 bullet（让 HR 转给 leader 不用翻译）+ 诚实点出 1 个小 gap
- **消息 3** — 3-5 天没回的 follow-up（≤60 字）：给 HR 台阶下，筛出僵尸岗

**Boss 规则：**
- 不发电话/微信号（平台会风控 + 违反全局规则）
- 不用"您好我对贵司充满热情"这类官腔
- 必须有 1 个 JD 里的具体关键词做钩子
- 不用 emoji

---

## 1. 找 target

**脉脉路径（warm outreach 专用）：**
1. 在脉脉搜公司名，看在职员工
2. 找 hiring manager（团队负责人）和 recruiter（招聘 HR）
3. 找 2-3 个同岗位 peer（背景相似的人）

**LinkedIn 路径**（仅外企/海外岗）：
1. 用 WebSearch：`site:linkedin.com/in {公司} {岗位关键词}`
2. 找 hiring manager + recruiter + peers

**注意：永远不要写出对方的电话号码或微信号。**

## 2. 选主 target

选 **最受益于候选人加入** 的那个人 — 通常是 hiring manager（不是 HR）。HR 是过滤器，hiring manager 是决策者。

## 3. 生成消息

### 脉脉触达消息（中文）

脉脉支持长一点的私信。3 段框架：

**段 1（钩子，1-2 句）：** 关于他公司的具体事 — 最好是技术博客、开源项目、最近的 Talk、产品更新。**不要泛泛说"我对贵司很感兴趣"**。

**段 2（证据，2-3 句）：** 候选人最相关的可量化成就。例如："我在 X 公司主导过 Y 项目，把 Z 指标从 A 提到了 B"。

**段 3（提议，1 句）：** 低压力的请求 — "想请您 15 分钟聊聊，了解一下团队对 [话题] 的方向，方便加个微信吗？" 或 "如果方便，能帮我看看我的简历是否合适这个岗位吗？"

**示例：**
> 您好 [姓名]，
>
> 看到贵司最近在做 [具体方向] 的探索（在 [来源] 看到的）。我自己过去 N 年一直在 [相关领域]，独立从 0 主导过 [具体项目]，把 [指标] 从 X 提到 Y。
>
> 看到贵司在招 [岗位]，想冒昧请您 15 分钟聊一下团队的方向，看是否合适。如果方便的话，可以约个电话或者加个微信？

**脉脉规则：**
- 不要超过 5 行
- 不要用「您好我对贵司充满热情」这种官腔
- 必须有一个具体的、能验证的细节
- 不要用 emoji（脉脉职场氛围偏正式）

### LinkedIn 消息（英文，仅外企/海外岗）

LinkedIn connection request 限 300 字符。3 句话框架：
1. **Hook**：something specific about their company or current AI challenge (NOT generic)
2. **Proof**：candidate's biggest quantifiable achievement relevant to THIS role
3. **Ask**：a low-pressure 15-min chat

### 微信触达（已经有微信号的情况）

微信第一句就直奔主题，不要寒暄。

> [姓名] 您好，我是 [候选人]，[同事 / 朋友] 推荐认识。看到贵司在招 [岗位]，我目前的方向和这个岗位高度相关，想请教您几个问题，方便聊一下吗？

## 4. 准备 2-3 个备选 target

每个 target 写一句"为什么是好的 second choice"。

## 5. 触达后跟进策略

- 发出去 3-5 天没回 → 不要刷屏
- 一周后可以发一次 follow-up，提供新信息（如"刚发了一篇关于 X 的文章，可能对您团队有用"）
- 还没回 → 换 target，不要纠结
