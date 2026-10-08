# Mode: radar — 远程"求职线索雷达"定期 routine

管理一个**远程（云端）定期 routine**：每隔几天自动用 WebSearch 扫上海/杭州的 AI 应用 / Agent 新岗，输出一份线索清单。

> 这是 `/schedule` skill 的封装。底层用 `RemoteTrigger` 工具（先 `ToolSearch select:RemoteTrigger` 加载）。
> **会话里默认已知现有 routine：** `trig_01SUBdxLfexRPfWAWmRYcVNR`（名称含「求职线索雷达」）。但每次都先 `list` 核实，别凭记忆。

## ⚠️ 远程的硬限制（一定要让用户知道，别假装能做到）

云端 agent **没有用户的本地文件，也没有用户的浏览器 / lark-cli**。`profile.yml`、`cv.md`、`portals.yml`、`applications.md` 都是 gitignored，不在 GitHub 上。所以雷达：
- ✅ 能做：WebSearch 线索发现 → 输出岗位清单（公司/岗位/城市/薪资/匹配理由/链接），结果在 routines 网页看。
- ❌ 做不到：抓 Boss/拉勾/猎聘 JD（登录墙+需本地 bb-browser）、A-F 评估（无 cv/profile）、写 tracker（无 lark-cli 授权）。
- 配套人工动作：雷达出线索 → 用户用 bookmarklet 抓 JD 到 inbox → 本地 `/career-ops inbox` 做完整评估。

## Workflow

### Step 1 — 先 list，判断状态

`RemoteTrigger {action:"list"}`，找名称含「求职线索雷达」的 routine。

- **不存在** → 走 Step 2（创建）。先确认节奏（默认每 2 天）、确认 repo（用户 fork，默认 `github.com/shuheng-mo/career-ops-china`）、确认 environment（默认 `env_01GaDTTmtq79nKTkZS8joPr9`，若用户环境不同先 list 环境）。
- **已存在** → 显示：节奏（cron 转成人话）、enabled、next_run_at（转北京时间）、结果网页链接 `https://claude.ai/code/routines/{id}`。然后问用户要干嘛：
  - **立即跑一次** → `RemoteTrigger {action:"run", trigger_id}`
  - **改节奏** → `update` 改 `cron_expression`（见下方 cron 速查）
  - **暂停 / 恢复** → `update` 改 `enabled`
  - **改搜索范围/城市/排除项** → `update` 改 `job_config...message.content`（用下方 Step 3 模板重生成）
  - **删除** → 不能用 API 删，引导用户去 https://claude.ai/code/routines

### Step 2 — 创建（不存在时）

用 `RemoteTrigger {action:"create", body:{...}}`，body 结构见 `/schedule` skill。要点：
- `name`: `求职线索雷达 — 上海/杭州 AI应用·Agent岗`
- `cron_expression`: 默认 `0 1 */2 * *`（UTC = 北京时间每 2 天约 09:00）
- `job_config.ccr.environment_id`: `env_01GaDTTmtq79nKTkZS8joPr9`（先 list 环境确认）
- `session_context.model`: `claude-sonnet-4-6`
- `session_context.sources`: `[{git_repository:{url:"https://github.com/shuheng-mo/career-ops-china"}}]`
- `session_context.allowed_tools`: `["WebSearch","WebFetch","Bash","Read","Write","Glob","Grep"]`
- `events[].data.uuid`: 现生成一个小写 v4 UUID（`uuidgen | tr 'A-Z' 'a-z'`）
- `events[].data.message.content`: 用 Step 3 的雷达 prompt（**画像/城市/公司清单必须写死在 prompt 里**，因为远程读不到 profile/portals）

创建后输出：人话节奏 + 首次运行北京时间 + 结果网页链接。

### Step 3 — 雷达 prompt（烤进 routine 的 content）

> **这里是模板，不是线上实际内容。** 下面 `{{...}}` 的占位符必须在 `update` 之前，用 `config/profile.yml`
> + `modes/_profile.md` + `config/target_pool.md` 的真实值替换掉 —— 远程 agent 读不到这些文件
> （它们都 gitignored，不在 GitHub 上），所以画像只能人工烤进 prompt。
>
> **本仓库是公开的**：不要把真实画像（学校 / 雇主 / 薪资期望 / base 城市）写回这个文件。
> 填好的完整 prompt 只存在于 routine 自己的配置里（`RemoteTrigger {action:"get"}` 可以看到）。

```
你是一个求职线索雷达。任务：用 WebSearch 找出最近的 AI 应用 / Agent 工程师新岗位，为候选人输出一份线索清单。

⚠️ 你在云端运行：不要访问本地文件、不要登录任何招聘平台、不要写任何 tracker/数据库。最后输出一份 markdown 清单作为你的最终消息。

## ⛔ 第一硬规则：只列能点名道姓的雇主

**每一条线索都必须有可核实的公司全名。** 以下一律不列，搜到了也丢掉：
- 「某公司」「某外企」「某创业公司」「某生物医药公司」「知名量化机构」「顶级 VC 支持的初创」等匿名雇主
- 猎头代招帖（猎聘 `/a/` 开头的链接多属此类），除非帖子正文里写明了真实雇主全名
- V2EX / 电鸭 / 知乎 招聘帖里不披露公司名的

理由：候选人无法判断匿名岗的签约主体，有命中「劳务派遣 / 外包」红线的风险，浪费双方时间。**宁可本次只出 3 条实名岗，也不要用匿名岗凑数。**

## 候选人画像（决定哪些算匹配）
- 意向：{{目标岗位}}，{{级别}}，约 {{薪资区间}}
- 强项：{{核心技能清单}}
- 背景：{{学历 + 工作年限 + 代表项目}}
- **{{社招/校招}}**，base {{首选城市}}，接受 {{次选城市}}；其它城市一律不要

## 只列这类岗（命中才列）
{{目标岗位的同义写法清单}}，且工作地在【{{首选城市}}】或【{{次选城市}}】。

## 直接排除（不要出现在清单里）
- 预训练 / RLHF / 多模态算法 / 模型加速 / 模型训练 等研究或算法岗
- 纯数据仓库 / 数仓 / 纯数据分析岗
- 纯 Java 后端（无 AI 元素）
- 明确写派遣 / 外包 / 业务外包的岗
- 要求顶会论文 / 顶尖博士 / 5% 顶尖人才 的高门槛岗
- **{{deal-breaker 公司}}**（任何 BU、任何子公司、任何 OD 身份）—— 从 `config/profile.yml` 的 `deal_breakers` 取
- **DeepSeek / Moonshot / 智谱 / 字节 Seed 的 Research 或 Foundation 核心岗** —— 这些公司本科硬筛 C9，候选人打不进（这些公司的纯应用层岗可以列）
- **实习岗 / 校招岗 / 应届生岗 / 管培生** —— 候选人是社招
- 硬性要求 5 年以上经验的岗

## 搜索范围
1. 大厂/独角兽在上海或杭州的 AI 应用/Agent 岗：字节（火山引擎 / Coze）、阿里（通义应用层 / 钉钉 / 淘天 / 阿里云 / 蚂蚁数科）、腾讯、美团、拼多多、网易、小红书、B站、快手、滴滴、MiniMax、阶跃星辰、面壁、上海人工智能实验室等 —— 优先查它们的**官方 careers 页**
2. 上海/杭州的中厂、上市公司、国企信息化子公司、以及实名的 AI 创业公司（电商/旅游/工业SaaS/硬件AI/金融科技/汽车AI/医药AI 方向）
3. WebSearch 示例 query：『上海 AI应用工程师 招聘 2026』『杭州 Agent 工程师 招聘』『大模型应用工程师 上海』『{公司名} AI应用 招聘 2026』『杭州 LLM 应用 招聘』

## ⚡ 效率提醒（别浪费轮次）
云端的 egress proxy **封锁了几乎所有中文招聘站的 WebFetch**：liepin.com、zhipin.com、v2ex.com、zhaopin.com、careers.aliyun.com、jobs.bytedance.com、shlab.org.cn、talent.*、indeed、知乎、掘金 全部 `EGRESS_BLOCKED`。
**所以：最多试 2 次 WebFetch，连续失败就彻底放弃 fetch，只用 WebSearch 摘要。** 不要反复重试不同 URL —— 历史上有一次跑了 50 轮全是被封的 fetch。拿不到正文就在「来源类型」列标注「仅搜索摘要」。

## 输出格式（你的最终消息，markdown）
第一行：日期 + 共找到 N 条线索。
然后一个表格，每条一行：

`公司全名 | 岗位 | 城市 | 薪资(如有) | 来源类型 | 一句话为什么匹配候选人 | 来源链接`

- **来源类型**填这三种之一：`官网直链`（公司自有 careers 页，无登录墙）/ `需登录`（猎聘/Boss/智联）/ `仅搜索摘要`（没读到正文）
- 排序规则：**先按来源类型排 —— 官网直链在最前**，同类型内按匹配度；杭州岗优先于上海岗
- 同一次扫描内按公司+岗位去重，不要同一个岗列两遍
- 最多 15 条。如果实名岗不足，就少列，并在末尾写一句『本次实名岗仅 N 条，匿名岗已按规则过滤掉 M 条』
- 如果确实没搜到值得提的新岗，就直说『本次无明显新增』

硬规则：绝不编造公司、岗位或链接 —— 只列你真实搜到、且带可点来源链接的。宁可少列，不要凑数。

末尾加一句提醒：『感兴趣的岗位用 bookmarklet 抓 JD 到 inbox，再在本地跑 /career-ops inbox 做完整评估。』
```

## Cron 速查（UTC；用户在 Asia/Shanghai，UTC+8）

| 想要 | cron | 说明 |
|------|------|------|
| 每 2 天 09:00 北京 | `0 1 */2 * *` | 默认（加速期）|
| 每天 09:00 北京 | `0 1 * * *` | 线索新增有限时偏多 |
| 每 3 天 09:00 北京 | `0 1 */3 * *` | 管道满了/降速用 |
| 每周一 09:00 北京 | `0 1 * * 1` | 低频 |

> 最小间隔 1 小时。`*/2` 这种"每隔 N"按 day-of-month 步进，月末会有一次衔接间隔，正常。

## 见相关 memory
`project_lead_radar_routine`（routine 元信息）、`feedback_bookmarklet_workflow`（配套人工抓取流程）、`feedback_scan_subagent_limitation`（为什么远程抓不了门户）。
