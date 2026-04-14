# Mode: story-sync — Story Bank 同步器

扫描 `reports/*.md` 中的 Block F（面试故事），抽取 STAR+R 故事，去重 + 按主题分组，写入 `interview-prep/story-bank.md`。

**核心问题：** auto-pipeline / batch worker 生成 Block F 后没有真正把故事追加到 master story bank，导致 13+ 次评估后 story-bank 仍是空模板。这个 mode 就是**存量补齐 + 每次评估后增量同步** 的工具。

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
2. `Read interview-prep/story-bank.md` → 看已有的 master story（找 `## Stories` 段）

### Step 2 — 问候选人：增量 or 重建

如果 `story-bank.md` 已有非模板内容：
```
发现 story-bank.md 已有 N 个故事 + 上次同步是 {YYYY-MM-DD}。
- 增量（recommended）：只追加 {那天之后} 新 report 中的新故事
- 重建：全扫全部 report，生成新 bank（旧的备份成 story-bank.md.bak）
选择？
```

首次运行 / 只有模板 → 默认**全扫**。

### Step 3 — 抽取每份 report 的 Block F

对每个 `reports/{NNN}-{slug}-{date}.md`：

1. `Read` 整个文件
2. 定位 `## F) 面试准备` 段，一直读到下一个 `## ` 或 `---` 为止
3. Block F 的**两种常见格式**要都能处理：

   **格式 A（表格 — 较旧 report）：**
   ```markdown
   | # | JD 要求 | 故事 | S | T | A | R | Reflection |
   |---|--------|------|---|---|---|---|-----------|
   | 1 | 大模型工程落地 | DBGPT 改造 | 华为需要降低查询成本 | 主导改造 | 重构 + SFT + 召回 | 准确率 92% | 微调数据质量比模型选型重要 |
   ```

   **格式 B（列表 — 较新 report）：**
   ```markdown
   ### 1. DBGPT 改造 → 92% 准确率
   - **Theme:** 大模型应用
   - **S:** 华为无线产品线...
   - **T:** 主导 DBGPT 改造...
   - **A:** 重构数据库连接 + SFT + Rerank...
   - **R:** 准确率 92%，提效 60%...
   - **Reflection:** 微调数据质量比模型选型重要
   - **Best for:** 个人项目 / LLM 工程化 / 数据质量
   ```

   **格式 C（自由叙述）：** 回落到语义抽取 — 识别 S/T/A/R/Reflection 对应的自然语言段。

4. 为每个故事生成 **candidate record**：
   ```json
   {
     "source_report": "001-kuaishou-llm-fintech-2026-04-07.md",
     "source_company": "快手",
     "source_role": "大模型应用开发工程师（金融支付）",
     "theme_tags": ["LLM应用", "SFT", "工程落地"],
     "story_title": "DBGPT 改造 → 92% 准确率",
     "canonical_key": "dbgpt",  // 用于跨 report 去重
     "S": "...", "T": "...", "A": "...", "R": "...",
     "Reflection": "...",
     "best_for": ["个人项目", "LLM 工程化", "数据质量"]
   }
   ```

### Step 4 — 语义去重（关键）

候选人的故事库**不是** 13 份 report × 7 故事 = 91 条流水账，而是 **5-10 个 master story 被多次复用**。去重 key：

| canonical_key | 识别关键词 | 预期出现在 |
|---------------|----------|----------|
| `elytra` | "Elytra", "Agentic SQL", "Hybrid Schema Retrieval", "Self-Correcting", "Multi-Model Routing" | 几乎每份 LLM / Agent 报告 |
| `dbgpt` | "DBGPT", "DB-GPT", "NL2SQL", "Spider 数据集", "DBGPT_HUB", "92%" | 几乎每份 LLM 报告 |
| `moss` | "Moss", "小苔藓", "5G AW", "faiss", "Milvus", "S3 向量索引", "70%" | RAG / 知识检索类 |
| `access` | "ACCESS", "PBAC", "权限", "SpringBoot", "iAuth", "60% 审批提速" | 后端 / 架构类 |
| `kaggle` | "Kaggle", "OTTO", "推荐系统", "银牌", "前 3%" | 推荐 / 数据科学类 |
| `cross_team` | "跨部门", "AAS", "MARP", "5G AW", "推动落地" | 协作 / Leadership 类 |
| `eval_methodology` | "Eval 体系", "Spider 测试集", "评估集", "数据驱动迭代" | Agent / LLM Eval 类 |

**合并规则：** 同 `canonical_key` 的多个 candidate 合并为一个 master：
- **S/T/A/R 文本：** 取**最详细**的版本（字数最多的）
- **Reflection：** 保留所有不同版本（因为 reflection 在不同语境下可能不同 — 比如对快手说"微调数据质量"，对 DeepSeek 可能说"eval 是 LLM 应用最大杠杆"）
- **theme_tags：** 所有出现过的 tags 去重并集
- **sources：** 完整列出所有引用的 report
- **best_for：** 所有出现过的并集

### Step 5 — 按主题分组

主题桶（按国内面试高频行为题）：

| 主题 | 适用故事 | 高频问题映射 |
|------|---------|------------|
| **个人项目 / Ownership** | Elytra | "最自豪的项目" / "独立负责过什么" / "业余时间在做什么" |
| **大模型应用落地** | DBGPT / Moss / Elytra | "LLM 工程化" / "从 demo 到生产" / "Eval" / "RAG 踩坑" |
| **RAG / 知识检索** | Moss / DBGPT | "向量检索经验" / "召回优化" / "embedding 选型" |
| **Agent / 多步推理** | Elytra | "Agent 架构" / "工具调用" / "自纠错" |
| **SFT / 模型训练** | DBGPT | "微调经验" / "数据构造" / "小模型 vs 大模型" |
| **数据工程 / 数仓** | DBGPT（数据侧）/ Moss（数据整合） | "ETL 经验" / "大规模数据处理" |
| **后端工程 / 架构** | ACCESS / Moss（接口设计） | "复杂系统重构" / "高并发" / "性能优化" |
| **数据科学 / 推荐** | Kaggle OTTO | "推荐系统经验" / "AB 实验" / "模型上线" |
| **跨部门协作 / Leadership** | Moss（5G AW 对接）/ ACCESS（跨团队）| "如何推动项目" / "跨团队冲突" / "影响他人" |
| **Eval / 方法论** | Elytra / DBGPT | "如何判断模型好坏" / "评估体系设计" |
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

- **个人项目 / Ownership** → [Elytra](#elytra)
- **大模型应用落地** → [Elytra](#elytra), [DBGPT](#dbgpt), [Moss](#moss)
- **RAG / 知识检索** → [Moss](#moss), [DBGPT](#dbgpt)
- **Agent / 多步推理** → [Elytra](#elytra)
- **SFT / 微调** → [DBGPT](#dbgpt)
- **数据工程 / 数仓** → [DBGPT](#dbgpt), [Moss](#moss)
- **后端 / 架构** → [ACCESS](#access)
- **数据科学 / 推荐** → [Kaggle OTTO](#kaggle)
- **跨部门协作** → [Moss](#moss), [ACCESS](#access)
- **Eval / 方法论** → [Elytra](#elytra), [DBGPT](#dbgpt)
- **离职 / 转方向叙事** → [narrative](#narrative)
- **红线问题** → [red-lines](#red-lines)

---

## Big Three 的组合建议

| 面试问题 | 推荐组合 |
|---------|---------|
| "自我介绍" | Elytra（个人项目破冰）→ DBGPT（上个工作主线）→ Moss（深度证据） — 3 min 版本 |
| "最有成就感的项目" | **Elytra**（独立设计 + 技术前沿 + 持续打磨）|
| "讲一次失败 / 改进" | DBGPT Reflection（微调数据 > 模型选型）或 Moss（召回必须加 rerank）|
| "跨部门冲突" | Moss 对接 5G AW / AAS / MARP 多团队协调 |
| "为什么离职" | narrative.exit_story — OD 身份限制 + 想转大模型主线 |

---

## Stories

### <a id="elytra"></a>[LLM 应用 · Agent · Eval · 个人项目] Elytra — Agentic SQL Generation

**Sources:** Report #001 (快手 LLM 应用), #003 (DeepSeek Agent 数据策略), #005 (DeepSeek 全栈), #006 (蚂蚁 Harness Agent)...  
**Theme tags:** LLM应用, Agent, Eval, 个人项目, Ownership, 前沿探索  
**Canonical key:** `elytra`

**S (Situation):** {从最详细的那份 report 抽 Situation}

**T (Task):** {同上}

**A (Action):** {同上，重点写 Hybrid Schema Retrieval + Self-Correcting + Multi-Model Routing 三个模块}

**R (Result):** {如有数据就写，没有就写"持续打磨中，README/架构图公开"}

**Reflection（多 source，分别列出）：**
- *From Report #001 (快手):* 单一模型 + 单次生成必然不够，必须做 Agent 化反馈闭环
- *From Report #003 (DeepSeek Agent Eval):* Eval 是 LLM 应用最大杠杆 — Self-Correcting 本质是把 eval 嵌到 inference
- *From Report #006 (蚂蚁):* 好的个人项目要经得起推翻重来 ≥2 次

**Best for questions about:** 最有成就感的项目 / 个人时间在做什么 / Agent 架构 / Eval 体系 / 大模型应用前沿 / Ownership / 持续学习

---

### <a id="dbgpt"></a>[LLM 应用 · SFT · RAG · 数据工程] DBGPT 改造 — NL2SQL 工程化

{... 同样结构 ...}

---

（继续所有 master story）

---

## <a id="narrative"></a>Narrative — 转方向叙事（非 STAR，但面试必问）

**问题模板：**
- 「为什么从华为离职？」
- 「为什么从数据治理转大模型？」
- 「gap 8 个月在做什么？」

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

- **如何新增：** 评估新岗位后，跑 `/career-ops story-sync` 增量更新
- **如何纠错：** 故事抽取不准？直接编辑本文件，下次 `story-sync` 会**检测到人工修改**并保留（不会覆盖你改的内容，只追加新来的）
- **如何删除：** 过时故事直接删除，story-sync 不会主动加回（只基于 report 新增）
```

### Step 7 — 备份 + 写入

1. 如果 `interview-prep/story-bank.md` 有非模板内容 → 备份为 `story-bank.md.bak.{YYYYMMDD-HHMMSS}`
2. `Write interview-prep/story-bank.md` 新内容
3. 如果 `story-bank.md` 有用户手动加的段（通过 `<!-- MANUAL: -->` 标记识别），保留这些段

### Step 8 — 输出汇总

```
Story Bank 同步完成 — {YYYY-MM-DD}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
扫描 report：N 份
原始候选故事：M 条
语义去重后：K 个 master story
分组主题：T 个

Master stories:
  1. Elytra (个人项目 · Agent · Eval) — 来自 4 份 report
  2. DBGPT (LLM 应用 · SFT) — 来自 8 份 report
  3. Moss (RAG · 知识检索) — 来自 5 份 report
  4. ACCESS (后端 · 架构) — 来自 2 份 report
  5. Kaggle OTTO (推荐 · 数据科学) — 来自 3 份 report
  ...

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
2. 重复录入同一个 canonical_key 的故事（去重失败会产生 5 个"Elytra" 条目）
3. 编造不存在于 report 中的 STAR 字段（如果原 report 的 A 段写得短，就保留短的，不要脑补）
4. 删除 narrative / red-lines 等非 STAR 段 — 这些是从 profile.yml 来的，不受 report 变化影响
