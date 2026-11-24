# Interview Studio — 面试准备、实战复盘、记忆训练与知识演进

> 状态：**P0+P1 已实现（shipped）**；Pack Compiler（P2）/ 本地 UI（P3）/ 实时 ASR 提词（P4）为 planned，未实现的功能不在本文档里冒充已支持。
> 规格：[`docs/interview-studio/spec-v0.2.md`](interview-studio/spec-v0.2.md) · 决策记录：[`docs/interview-studio/decisions.md`](interview-studio/decisions.md)

## 这是什么

面试工作台闭环：**Interview Brain**（从 CV/逐字稿逐步建立可版本化的知识块、问题索引与事实引用）+ **Interview Replay**（逐字稿导入 → 问题对齐 → rubric 复盘 → 事实冲突闸门 → 改进队列）+ **Heatmap**（真实面试频率 k/n、掌握度、复习优先级）+ **知识演进**（patch 提案逐条审批）。

**逐字稿不是必需品**：新用户仅凭 CV 即可冷启动（onboarding 可跳过）。

**P3 已实现（shipped）**：本地 Studio（`npm run interview:studio`）——只监听 127.0.0.1，启动打印随机 token（URL 带 token 访问）；知识库查看/检索/编辑、面试包查看、Heatmap、**文字练习三模式**（完整提词/锚点/盲测，盲测在揭示前不返回任何块内容，`hint.revealed` 落事件且该次不进独立掌握度）、Replay（说话人纠正/对齐确认）、Settings。中文默认、深浅跟随系统、紫色仅品牌强调、零 CDN（CSP `default-src 'self'`）。转录等非可信内容渲染时 HTML-escape。

**P3.3（library 就绪，server 接线待做）**：BYOK embedding 适配层（OpenAI-compatible，如百炼 text-embedding-v4）+ 内存缓存 + hybrid RRF 融合已实现并有完整测试（含 stub server 与失败降级），但 Studio server 的检索端点**尚未接线** embedding 配置（当前检索恒为 lexical，基础操作不受影响）。接线留给 P4 前的收尾。Judge 走 P1 的 agent 导出/回填路径（规格允许），未做 API judge。

**P4 已实现（shipped，真实 Key 验收待用户）**：实时链路全部结构——麦克风采集（AudioWorklet 16k PCM）、WS 通道、Fast/Slow path（partial 不定位/候选人回答不触发/锁定/600ms 防抖/新问题作废旧 token/盲测实时链路同样不泄漏）、ASR adapter 三件套：**mock**（演练用）/**阿里云百炼 fun-asr-realtime**（WS 协议完整实现，协议正确性经本地 stub 验证；真实 Key 连通性/热词/费用读数属用户验收）/**sherpa-local**（动态加载 + manifest 校验，识别引擎接线待模型目录确认）。成本闸门：默认 90 分钟/场、云 ASR 预算 3 元、2s 发送缓冲超限记 gap、重连 ≤2 次且换新 streamId。降级矩阵：Key 未配 → mock 演练可用；云端失败 → 文本/手动模式，不静默换供应商。

**P2 已实现（shipped）**：Interview Pack Compiler——按申请编号编译企业面试包。公司资料逐字引用评估报告 Block C 并带 freshness 判定（>7 天提示重查、>30 天标过期）；needs_review 块进「硬闸门」段不进正文；预算不足显式列出未覆盖块；freeze 后包内容不受知识库后续变化影响。测试与离线场景用 `--fixtures-tracker / --reports-dir / --cv-file` 注入（不触真实 tracker）。

## 安装与无 Key 体验

```bash
npm install        # 依赖：yaml / ajv（P1 新增，均纯 JS）；已装则跳过
npm run interview:kb -- doctor    # 环境体检（node ≥22 / 依赖 / 数据目录可写 / 配置）
npm run interview:kb -- init        # 建本地数据目录（幂等）
npm run interview:kb -- bootstrap --from cv   # CV 冷启动生成种子问题
npm run interview:kb -- dig prepare # 出 ≤5 题深挖问卷
# （在对话里答完）→ dig ingest → drafts export → approve → practice
```

**全程不需要任何 API Key**：确定性操作（校验/存储/检索/统计）全部本地；语义任务（问题切分、对齐、判分草稿）走「CLI 导出任务 JSON → agent 回填 → CLI 校验提交」的离线路径，人工标注也可以手工构造 JSON 回填。默认 `interview.enabled: false`——不 init、不启用，旧流程零变化。

## 两条完整 synthetic demo（无需任何真实数据）

```bash
node tools/interview/eval/demo-a-cv-coldstart.mjs
# 仅虚构 CV → 种子 → 深挖 → 审批 → 首批练习题单 → JD 增量信号；断言真实热度保持 null

node tools/interview/eval/demo-b-transcript-replay.mjs
# 虚构逐字稿 → 对齐 → 复盘（含事实冲突闸门）→ 真实统计 → patch 应用与同义问合并去重
```

两/demo 均在临时目录运行，**绝不触碰真实 `interview-prep/`**；`npm run test:interview` 会同时跑全部单测与两条 demo。

## CLI 命令一览（`npm run interview:kb -- <command>`）

| 命令 | 用途 |
|---|---|
| `init` / `doctor` | 建目录（幂等）/ 环境体检 |
| `validate --file <block.md>` | 校验知识块 front matter（answer-block schema） |
| `bootstrap --from cv [--cv <路径>]` / `bootstrap status` | CV 冷启动 / 进度 |
| `seed list` | 列种子（候选问题） |
| `dig prepare` / `dig ingest --file <result.json>` | 深挖 ≤5 题 / 收答案（答/跳过/记不清/没做过） |
| `drafts export` / `approve --file <drafts.json>` | 导出草稿任务 / **人工批准后**激活知识块 |
| `practice [--track <t>]` | 输出可练习题单（问题+锚点+30秒版） |
| `import --file <笔记.md>` / `import apply --file <candidates.json>` | 已有逐字稿/笔记导入（与 CV-only 共用审批路径） |
| `transcript import --file <md\|srt\|json> [--application N] [--round 一面]` | 逐字稿标准化（重复导入自动复用） |
| `segment export/apply` / `align export/apply --session <id>` | 问题切分 / 知识块对齐 |
| `review prepare/apply/show --session <id>` | rubric 复盘（30/25/20/15/10，冲突硬闸门） |
| `stats [--track] [--round] [--days 180]` | 频率 k/n、掌握度、优先级 |
| `signals reconcile [--scan-reports] [--check-cv]` | JD/Block F 信号登记 + CV 账本增量核验 |
| `pack build --application N --round R [--minutes 60]` | 编译企业面试包（tracker+report+CV+知识块 → 考前一页/硬闸门/覆盖缺口/反问/准备计划） |
| `pack list / show <id> / freeze <id>` | 列包 / 渲染（冻结包只读快照）/ 冻结 |
| `patch propose/list/approve/reject/apply` | 知识演进（同义问/改块/事实冲突/归档/合并） |

Agent 编排入口：`/career-ops interview-prep`、`/career-ops interview-review <num>`、`/career-ops interview-evolve`、`/career-ops interview-heatmap`。

## 数据与隐私

- 全部个人数据在 gitignored 的 `interview-prep/`：`imports/`（原件+SHA256）、`knowledge/`（块/种子/信号/版本 manifest）、`sessions/`、`reviews/`、`patches/`
- **测试与 demo 用 `--root <临时目录>` / `--cv <虚构 fixture>` 注入**，自动化永不读写真实数据目录（ADR-0001 #4）
- 不联网、不上传：无云端 ASR、无 embedding、无 LLM 调用（P4 起云端服务默认关闭，启用是显式决定）
- 不写 Tracker、不发飞书消息、不调用 `addRound`；cv.md 与 evolve 账本只被引用，永不被本模块改写
- 删除：整目录删除 `interview-prep/` 即可（派生 cache 可重建）

## 已知限制（P1）

- 检索为纯词法（BM25 + 中文 bigram）；阈值保守，改写问句走「候选展示 + 人工确认」而非自动跳
- 角色（面试官/候选人）只认显式标签，无标签的逐字稿保持 unknown，需人工确认
- 高并发分布式评分、语速语气等不可从文本推断的维度一律 unknown，不判错
- 优先级公式中 relevance 维度在 P1 恒为 null（无 JD 关联数据）
