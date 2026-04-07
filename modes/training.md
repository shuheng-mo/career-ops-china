# Mode: training — 培训 / 课程 / 认证评估

候选人问某个课程/证书值不值得学时，按 6 个维度评估：

| 维度 | 评估什么 |
|------|---------|
| 北极星对齐度 | 拉近还是拉远目标？ |
| HR / 面试官信号 | 写在简历上 hiring manager 怎么看？ |
| 时间和精力 | 周数 × 每周小时 |
| 机会成本 | 这段时间不能做什么？ |
| 风险 | 内容过时？品牌弱？太基础？ |
| Portfolio 产出 | 能不能做出一个能 demo 的东西？ |

## 推荐结论

- **学** → 4-12 周计划，每周交付 + scoreboard
- **不学** → 给一个更好的替代方案 + 理由
- **限时学（最多 X 周）** → 浓缩计划，只保留最关键部分

## 优先级（数据/AI/平台方向）

国内市场上能加分的方向（按 archetype）：

**数据工程 / 数仓：**
1. Spark / Flink 性能调优（实战项目，不是基础课）
2. 湖仓一体（Iceberg / Hudi / Paimon）
3. 实时数仓（Flink CDC + Doris/StarRocks）
4. 数据治理工具实战（Atlas / Datahub / Amundsen）

**大模型应用：**
1. RAG 进阶（Hybrid Search、Reranking、Eval 体系）
2. Agent 框架实战（LangGraph / AutoGen / 自研）
3. LLM Eval（Ragas / DeepEval / 自研评测集）
4. 模型微调（LoRA / SFT / DPO / RLHF）

**AI Infra：**
1. vLLM / SGLang 源码与部署
2. 分布式训练（DeepSpeed / Megatron / Colossal-AI）
3. GPU 调度（Kubernetes Device Plugin）
4. 模型量化（GPTQ / AWQ / Smoothquant）

**后端 / 平台：**
1. 高并发系统设计（电商秒杀级别）
2. 分布式系统（Raft / Paxos / 一致性协议）
3. 云原生（K8s + Istio + Observability）

## 国内常见付费课程的避坑

- **培训机构包装的"AI 工程师就业班"** → 几乎不会被互联网大厂认可，HR 一眼就能看出来
- **"CDA 数据分析师"等国内认证** → 国企/外企/部分中小厂认，互联网大厂基本不看
- **AWS / 阿里云 / 火山引擎认证** → ToB / 解决方案 岗位有用，纯研发岗 用处不大
- **Coursera / Udemy / B 站免费课** → 重要的是产出物，不是证书。**做出能 demo 的项目比拿证书重要 10 倍**

**总原则：能做出一个真实可演示的项目（带 GitHub + 博客文章 + 数据指标）的"学习"，永远比拿一个证书有价值。**
