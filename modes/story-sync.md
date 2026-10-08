# Mode: story-sync — Story Bank 同步器

扫描两类源，抽取 STAR+R 故事 + 实战 refinement，去重 + 按主题分组，写入 `interview-prep/story-bank.md`。

**两类源（按权重）：**

| 源 | 路径 | 性质 | 贡献 |
|----|------|------|------|
| **Primary：** 评估报告 Block F | `reports/{NNN}-{slug}-{YYYY-MM-DD}.md` | 评估时预生成（可能未经实战）| 初始 STAR+R 骨架、Reflection 初稿 |
| **Supplemental：** Mock interview 备战笔记 | `interview-prep/mock-interviews/{NNN}-{slug}-{roundN}-{YYYY-MM-DD}.md` | **gitignored**，本地专属；一面/二面**前后**迭代；有实战信号 | Refined S/T/A/R、实战 Reflection、真实 Q&A、架构 trade-off、代码片段、文化深聊话术 |

**为什么 mock-interviews 是关键二级源：**

- 评估报告 Block F 是**冷生成**（Claude 根据 JD 预想面试要点）
- mock-interview 笔记是**热迭代**（一面结束后复盘 + 二面冲刺准备），包含真实问题、踩过的坑、调整过的话术、blind recall 代码骨架
- 若同一 story 在两处出现差异，**mock 版本更新 / 覆盖 report 版本**（因为是更接近真实面试的打磨版）

**Gitignore 注意：** `interview-prep/mock-interviews/*.md` 和 `interview-prep/story-bank.md` 都在 `.gitignore` 中（story-bank 历史 tracked 但新 diff 忽略）。因此 story-bank 可以安全包含 mock-interview 提炼的候选人专属细节（如薪资底牌、真实对家 offer、私下判断等）不用担心泄漏到 git。

**核心问题：** auto-pipeline / batch worker 生成 Block F 后没有真正把故事追加到 master story bank，且 mock-interview 的实战 refinement 没有系统回流。这个 mode 就是**存量补齐 + 每次评估后增量同步 + 每次面试后 refinement 回流** 的工具。

## 推荐执行方式

作为 **subagent** 跑（避免主 session 读 13+ 份 report 炸 context）：

```
Agent(
    subagent_type="general-purpose",
    prompt="[本文件内容 + 具体参数]",
    run_in_background=True
)
```

---

## Workflow

### Step 1 — 读现状

1. `ls reports/*.md | sort` → 所有已生成的 report
2. `ls interview-prep/mock-interviews/*.md | sort` → 所有 mock interview 备战笔记（gitignored，本地专属）
3. `Read interview-prep/story-bank.md` → 看已有的 master story（找 `## Stories` 段）
4. **tracker # 交叉索引：** 从 mock-interviews/*.md 文件名头 3 位数字（`061-{company-slug}-round2-...` → tracker #61）对齐到 `data/applications.md` 第 # 列，拿到 company/role，再定位对应的 `reports/{report#}-{slug}-*.md`

### Step 2 — 问候选人：增量 or 重建

如果 `story-bank.md` 已有非模板内容：
```
发现 story-bank.md 已有 N 个故事 + 上次同步是 {YYYY-MM-DD}。
- 增量（recommended）：只追加 {那天之后} 新 report 中的新故事
- 重建：全扫全部 report，生成新 bank（旧的备份成 story-bank.md.bak）
选择？
```

首次运行 / 只有模板 → 默认**全扫**。

### Step 3a — 抽取每份 report 的 Block F（Primary 源）

对每个 `reports/{NNN}-{slug}-{date}.md`：

1. `Read` 整个文件
2. 定位 `## F) 面试准备` 段，一直读到下一个 `## ` 或 `---` 为止
3. Block F 的**两种常见格式**要都能处理：

   **格式 A（表格 — 较旧 report）：**
   ```markdown
   | # | JD 要求 | 故事 | S | T | A | R | Reflection |
   |---|--------|------|---|---|---|---|-----------|
   | 1 | 大模型工程落地 | [项目名] | [业务背景] | [你的角色] | [关键动作] | [量化结果] | [你学到的] |
   ```

   **格式 B（列表 — 较新 report）：**
   ```markdown
   ### 1. [项目名] → [标志性指标]
   - **Theme:** 大模型应用
   - **S:** [业务背景 / 痛点]...
   - **T:** [你负责什么]...
   - **A:** [具体做了哪几件事]...
   - **R:** [量化结果]...
   - **Reflection:** 微调数据质量比模型选型重要
   - **Best for:** 个人项目 / LLM 工程化 / 数据质量
   ```

   **格式 C（自由叙述）：** 回落到语义抽取 — 识别 S/T/A/R/Reflection 对应的自然语言段。

4. 为每个故事生成 **candidate record**：
   ```json
   {
     "source_type": "report",
     "source_file": "001-{company-slug}-{role-slug}-{date}.md",
     "source_company": "[公司名]",
     "source_role": "[岗位名]",
     "theme_tags": ["LLM应用", "SFT", "工程落地"],
     "story_title": "[项目名] → [标志性指标]",
     "canonical_key": "{{项目 slug}}",  // 用于跨 report 去重
     "S": "...", "T": "...", "A": "...", "R": "...",
     "Reflection": "...",
     "best_for": ["个人项目", "LLM 工程化", "数据质量"]
   }
   ```

### Step 3b — 抽取每份 mock-interview 笔记（Supplemental 源）

对每个 `interview-prep/mock-interviews/{NNN}-{slug}-{round}-{date}.md`：

1. `Read` 整个文件
2. **不存在 Block F 固定结构** — 按自由格式，按类型分拣：

   | 内容类型 | 识别信号 | 贡献到 story-bank |
   |---------|---------|------------------|
   | **Refined 故事段落**（如"某项目的代码 blind recall"、"架构 trade-off"）| 命中 `_profile.md` 中任一 canonical_key 的识别关键词 | 更新对应 master story 的 S/T/A/R（取字数更长或更新近的版本） |
   | **新的 Reflection / 踩坑心得** | "为什么 / 如果改 X 会 / 踩过 / 教训" 等问答对 | 追加到对应 story 的 `Reflection` 段，标签 `from mock prep (Round N · tracker #NN · YYYY-MM-DD)` |
   | **真实 Q&A（架构题 / 场景题 / 代码题）** | "问：... / 答：..." 或 trade-off 表格 | 加入新段 `## 实战 Q&A 清单` 按 canonical_key 分组 |
   | **文化深聊 / 红线问题话术** | "能接受 996 吗 / 为什么离职 / 期望薪资" 等 | 更新 `## 红线问题应对` 表（合并新话术）|
   | **代码 blind recall 骨架** | 出现 markdown 代码块 + 标注"能写 / 白板" | 加入 `## 代码骨架备忘`（新段）按 canonical_key 索引，行数 ≤ 20 |

3. 生成 **candidate record**：
   ```json
   {
     "source_type": "mock",
     "source_file": "0NN-{company-slug}-round2-prep-{date}.md",
     "tracker_num": NN,
     "company": "{公司名}",
     "round": "round2",
     "date": "2026-04-20",
     "contributions": [
       {"type": "refined_story", "canonical_key": "{{key}}", "field": "A", "new_text": "..."},
       {"type": "reflection_add", "canonical_key": "{{key}}", "lesson": "..."},
       {"type": "real_qa", "canonical_key": "{{key}}", "question": "...", "answer": "..."},
       {"type": "code_skeleton", "canonical_key": "{{key}}", "title": "...", "code": "..."},
       {"type": "red_line", "issue": "期望薪资", "answer_template": "..."}
     ]
   }
   ```

### Step 4 — 语义去重 + 多源合并（关键）

候选人的故事库**不是** 13 份 report × 7 故事 = 91 条流水账，而是 **5-10 个 master story 被多次复用**。去重 key：

**canonical_key 表从 `modes/_profile.md` 的「Story Bank canonical keys」段读取**（那个文件 gitignored，放你自己的真实项目名和指标）。表的形状：

| canonical_key | 识别关键词 | 预期出现在 |
|---------------|----------|----------|
| `{{项目 slug}}` | 该项目的专有名词、技术栈、标志性指标数字 | 哪类 JD 的报告里会出现 |

一般 5-10 个 key 就够：2-3 个个人项目 + 2-3 个工作项目 + 1-2 个竞赛/开源 + 跨部门协作 + 方法论。
**没有 `_profile.md` 或该段为空** → 先扫 `reports/*.md` 的 Block F 自动归纳出候选 key，列给用户确认后写进 `_profile.md`，再继续。

**合并规则：** 同 `canonical_key` 的多个 candidate 合并为一个 master：
- **S/T/A/R 文本：** 优先级 **mock（实战） > report（冷生成）**。若 mock 版本存在且字数 ≥ report 版本的 70% → 采用 mock 版本；否则仍按最详细原则
- **Reflection：** 保留**所有**不同版本（区分来源：`from Report #NNN` vs `from Mock #NN (RoundN · date)`），因为 reflection 在不同语境下可能不同
- **theme_tags：** 所有出现过的 tags 去重并集
- **sources：** 分两列：`Reports:` 列出所有 report #NNN；`Mock Interviews:` 列出所有 mock 文件（tracker # + round）
- **best_for：** 所有出现过的并集（mock 版本贡献的通常更精准，因为含真实 Q&A）

### Step 5 — 按主题分组

主题桶（按国内面试高频行为题）：

「适用故事」列填 canonical_key，映射关系从 `modes/_profile.md` 的「主题桶 → 适用故事」表读取。高频问题映射是通用的：

| 主题 | 适用故事 | 高频问题映射 |
|------|---------|------------|
| **个人项目 / Ownership** | `{{key}}` | "最自豪的项目" / "独立负责过什么" / "业余时间在做什么" |
| **大模型应用落地** | `{{key}}` | "LLM 工程化" / "从 demo 到生产" / "Eval" / "RAG 踩坑" |
| **RAG / 知识检索** | `{{key}}` | "向量检索经验" / "召回优化" / "embedding 选型" |
| **Agent / 多步推理** | `{{key}}` | "Agent 架构" / "工具调用" / "自纠错" |
| **SFT / 模型训练** | `{{key}}` | "微调经验" / "数据构造" / "小模型 vs 大模型" |
| **数据工程 / 数仓** | `{{key}}` | "ETL 经验" / "大规模数据处理" |
| **后端工程 / 架构** | `{{key}}` | "复杂系统重构" / "高并发" / "性能优化" |
| **数据科学 / 推荐** | `{{key}}` | "推荐系统经验" / "AB 实验" / "模型上线" |
| **跨部门协作 / Leadership** | `{{key}}` | "如何推动项目" / "跨团队冲突" / "影响他人" |
| **Eval / 方法论** | `{{key}}` | "如何判断模型好坏" / "评估体系设计" |
| **离职 / 转方向叙事** | （从 profile.yml 读，不是 STAR） | "为什么离开上家" / "为什么转大模型" |
| **红线问题应对** | （话术，不是 STAR） | "996 接受吗 / 婚育计划 / 频繁跳槽" |

同一个故事可以归多个主题（用 `theme_tags` 表达）。

### Step 6 — 写 story-bank.md

完全覆盖重写（把原来的模板 + 占位符全部替换）。新结构：

```markdown
# Story Bank — Master STAR+R Stories

**最后同步：** {YYYY-MM-DD}  
**故事总数：** {N} 个 master story  
**源报告：** {M} 份（reports/*.md）

---

## 主题快速导航

每个主题指向对应 canonical_key 的锚点，按 `modes/_profile.md` 的主题桶表生成：

- **个人项目 / Ownership** → `[{{key}}](#{{key}})`
- **大模型应用落地** → `[{{key}}](#{{key}})`, ...
- **RAG / 知识检索** → `[{{key}}](#{{key}})`, ...
- **Agent / 多步推理** → `[{{key}}](#{{key}})`
- **SFT / 微调** → `[{{key}}](#{{key}})`
- **数据工程 / 数仓** → `[{{key}}](#{{key}})`
- **后端 / 架构** → `[{{key}}](#{{key}})`
- **数据科学 / 推荐** → `[{{key}}](#{{key}})`
- **跨部门协作** → `[{{key}}](#{{key}})`
- **Eval / 方法论** → `[{{key}}](#{{key}})`
- **离职 / 转方向叙事** → [narrative](#narrative)
- **红线问题** → [red-lines](#red-lines)

---

## Big Three 的组合建议

| 面试问题 | 推荐组合 |
|---------|---------|
| "自我介绍" | `{{个人项目 key}}`（破冰）→ `{{上个工作主线 key}}` → `{{深度证据 key}}` — 3 min 版本 |
| "最有成就感的项目" | **`{{最强个人项目 key}}`**（独立设计 + 技术前沿 + 持续打磨）|
| "讲一次失败 / 改进" | 带最有洞察的 Reflection 的那个 key |
| "跨部门冲突" | `cross_team` key（多团队协调那段经历）|
| "为什么离职" | narrative.exit_story（从 `config/profile.yml` 读）|

---

## Stories

### <a id="{{key}}"></a>[LLM 应用 · Agent · Eval · 个人项目] {{项目名}} — {{一句话定位}}

**Sources — Reports:** #NNN ({公司} {岗位方向}), #NNN (...), ...  
**Sources — Mock Interviews:** #NN RoundN ({公司}, {date})  
**Theme tags:** {所有出现过的 tags 并集}  
**Canonical key:** `{{key}}`

**S (Situation):** {若 Mock 有更新版本用 Mock；否则取最详细 report 版本}

**T (Task):** {同上}

**A (Action):** {同上，重点写该项目 2-3 个最硬的技术模块}

**R (Result):** {如有数据就写，没有就写"持续打磨中，README/架构图公开"}

**Reflection（按来源分别列出）：**
- *From Report #NNN ({公司}):* {那份报告里提炼的心得}
- *From Mock #NN RoundN ({公司}, {date}):* {实战打磨过的更深版本 —— 通常含面试官的追问和你的答法}

**Best for questions about:** {该 story 适配的问题清单，所有来源的并集}

---

### <a id="{{key-2}}"></a>[{主题标签}] {{项目名 2}} — {{一句话定位}}

{... 同样结构 ...}

---

（继续所有 master story）

---

## <a id="real-qa"></a>实战 Q&A 清单（from mock interviews）

**来源：** `interview-prep/mock-interviews/*.md`（gitignored，本地专属实战打磨）。每条记录**真实被问过或高概率被问**的问题 + 打磨过的答案。按 canonical_key 索引。

### [{{key}}] {{项目名}} 相关

- **Q（Mock #NN RoundN, {date}）：** {真实被问过的问题}
  **A：** {打磨过的答案 —— 带数据和 trade-off 理由，不要空话}
- **Q：** {下一个}
  **A：** {...}

### [{{key-2}}] {{项目名 2}} 相关

{...同上结构...}

---

## <a id="code-skeletons"></a>代码骨架备忘（blind recall）

**来源：** `interview-prep/mock-interviews/*.md` 中的 "blind recall" / "白板写" 段落。每条 ≤ 20 行，面试前 1 晚复习。

### [{{key}}] {{要能白板写出来的那个核心结构}}（Mock #NN RoundN）

```python
{从 mock 文件抽取的代码骨架 ≤20 行}
```

### [{{key}}] {{第二个}}

```python
{...}
```

---

## <a id="narrative"></a>Narrative — 转方向叙事（非 STAR，但面试必问）

**问题模板：**
- 「为什么从上家离职？」
- 「为什么从 {原方向} 转 {目标方向}？」
- 「gap 这段在做什么？」

**标准答话（从 `config/profile.yml → narrative.exit_story` 生成）：**

{profile.yml 的 exit_story 内容 + 个性化润色}

---

## <a id="red-lines"></a>红线问题应对

国内 HR 常问但涉嫌歧视 / 非技术问题，事先准备得体应对：

| 问题 | 应对要点 |
|------|--------|
| 能接受 996 吗 | 「短期冲刺 OK，长期不可持续。可以了解团队过去 3 个月真实工时吗？」|
| 最晚能到几点 | 同上 |
| 婚育计划 | 「这是个人问题，咱们能聚焦岗位本身吗？」|
| 为什么频繁跳槽 | （候选人目前只有 1 份工作 + gap — 暂不适用）|
| 期望薪资 | 「结合市场行情和岗位要求，区间是 X-Y。结构可谈，看 total package。」|
| 还有其他 offer 吗 | 诚实 — 但不透露具体数字 |

---

## 维护

- **如何新增：**
  - 评估新岗位后，跑 `/career-ops story-sync` 增量更新（从 `reports/*.md` 抽）
  - **面试前/后写了 mock interview 备战笔记**（`interview-prep/mock-interviews/{tracker#}-{slug}-{round}-{date}.md`）后，再跑一次 `/career-ops story-sync`，系统会把 mock 中的 refined S/T/A/R、实战 Reflection、真实 Q&A、代码骨架回流到 story-bank
- **如何纠错：** 故事抽取不准？直接编辑本文件，下次 `story-sync` 会**检测到人工修改**并保留（不会覆盖你改的内容，只追加新来的）
- **如何删除：** 过时故事直接删除，story-sync 不会主动加回（只基于 source 新增）
- **gitignore 注意：** `story-bank.md` 和 `mock-interviews/*.md` 都在 gitignore 中。可以安全存候选人专属内容（薪资底牌、真实对家、私下判断、fresh 的面试官原话）不用担心泄漏到 git
```

### Step 7 — 备份 + 写入

1. 如果 `interview-prep/story-bank.md` 有非模板内容 → 备份为 `story-bank.md.bak.{YYYYMMDD-HHMMSS}`
2. `Write interview-prep/story-bank.md` 新内容
3. 如果 `story-bank.md` 有用户手动加的段（通过 `<!-- MANUAL: -->` 标记识别），保留这些段

### Step 8 — 输出汇总

```
Story Bank 同步完成 — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
扫描 reports：N 份
扫描 mock-interviews：N_mock 份（gitignored，本地专属）
原始候选故事：M 条
语义去重后：K 个 master story
分组主题：T 个

Master stories:
  1. {{key}} (主题标签)
     — Reports: N 份 / Mock: N 份（#NN RoundN {公司}）
  2. {{key-2}} (主题标签)
     — Reports: N 份 / Mock: N 份
  3. {{key-3}} (主题标签)
     — Reports: N 份 / Mock: N 份
  ...

Mock-only contributions（不对应任何 master story 的独立素材）:
  - 实战 Q&A：{N} 条（from Mock #61 Round2）
  - 代码骨架：{N} 段
  - 红线问题话术更新：{N} 条

输出：interview-prep/story-bank.md ({行数} 行)
{如果有备份} 旧版备份：story-bank.md.bak.{ts}
```

---

## 规则

### 永远要
1. 用**语义去重**，不要机械按 story title 去重（同一个项目在不同 report 里叫法不同）
2. **保留多个 Reflection** — 这是 story bank 相对单份 report 的真正价值（同一故事在不同面试语境下的不同 lesson）
3. 每个 story 必须有 `Sources:` 列出所有引用 report，方便用户回溯
4. 按主题分组 + 加锚点跳转 — 面试前 5 分钟要能快速定位故事

### 永远不要
1. 覆盖用户手动加的段（用 `<!-- MANUAL START -->` / `<!-- MANUAL END -->` 识别）
2. 重复录入同一个 canonical_key 的故事（去重失败会产生 5 个同名条目）
3. 编造不存在于 source 中的 STAR 字段（如果原 report/mock 的 A 段写得短，就保留短的，不要脑补）
4. 删除 narrative / red-lines 等非 STAR 段 — 这些是从 profile.yml 来的，不受 source 变化影响
5. **把 mock-interview 的内容回流到 `reports/*.md`** — reports 已 commit 到 git，不要把候选人专属细节（薪资底牌、对家 offer、实时面试官原话）写回 reports；这类信息只保留在 story-bank.md（gitignored）和 mock-interviews/（gitignored）
6. **扫 mock-interviews 时不要 `Read` 进主 session 的 context** — 用 subagent 扫完后只回传结构化的 candidate records；mock 文件可能很长（100-200 行）且含大量代码，直接进主 session 会炸 context
