# career-ops 浏览器 bookmarklets

绕过国内招聘平台的反爬 / 反复制 / 登录墙限制，让你 **一键** 把 JD 发给 Claude 评估。

## 工作原理

```
浏览器（你看到的 JD 页面）
    │
    │ 1. 点 bookmarklet 按钮
    ▼
本地 HTTP 服务器（localhost:8787）
    │
    │ 2. 收到 POST，写 inbox/*.json
    ▼
inbox/jd-{时间戳}-{平台}-{标题}.json
    │
    │ 3. 你跑 /career-ops inbox
    ▼
Claude 自动评估 → report + PDF + tracker
```

## 一次性安装（5 分钟）

### Step 1 — 启动本地服务器（每次开机后跑一次）

```bash
cd /path/to/career-ops
npm run inbox-server
# 或 node tools/jd-inbox-server.mjs
```

服务器跑在 `http://localhost:8787`。**保持终端开着**，关了就要重启。

如果想后台跑：
```bash
nohup node tools/jd-inbox-server.mjs > logs/inbox-server.log 2>&1 &
```

### Step 2 — 安装 bookmarklets

1. 终端跑：`npm run build-bookmarklets`（生成 `tools/install.html`）
2. 浏览器打开 `tools/install.html`（直接 `open tools/install.html`）
3. 显示书签栏：Chrome/Edge/Safari `⌘+Shift+B`
4. 把彩色按钮 **拖** 到书签栏

推荐至少装这 3 个：
- 🌐 **JD Capture (通用)** — 80% 场景用这个
- 💼 **Boss 直聘** — Boss 详情页专用
- 🏢 **大厂 Careers SPA** — 字节/阿里/腾讯/美团 等

## 日常使用（每次抓 JD 5 秒）

1. 浏览器打开任意 JD 页（Boss / 猎聘 / 拉勾 / 公司 careers / Mokahr）
2. 点书签栏对应的 bookmarklet
3. 看到 `✓ JD captured` 弹窗 → 收工
4. 回到 Claude 跑 `/career-ops inbox` 自动评估全部待处理

## 5 个 bookmarklets 怎么选

| Bookmarklet | 适合的页面 |
|-------------|-----------|
| 🌐 通用 | V2EX 招聘 / GitHub README / 公司自有 careers 静态页 / 不确定时先试这个 |
| 💼 Boss 直聘 | `zhipin.com` 详情页（专门处理 Boss 反复制）|
| 🎯 猎聘 | `liepin.com` 详情页 |
| 🛒 拉勾 | `lagou.com` 详情页 |
| 🔑 Mokahr ATS | DeepSeek / 部分独角兽 ATS（`mokahr.com`、`app.mokahr.com`、`*.mokahr.com`）|
| 🏢 大厂 SPA | 字节 / 阿里 / 蚂蚁 / 腾讯 / 美团 / 快手 / 小红书 careers / B 站 / 网易 / 京东 / 拼多多 / 百度 / 滴滴 / 智谱 / MiniMax / 阶跃 / 面壁 等 careers SPA |

## LinkedIn：不用 bookmarklet，跑脚本

cn.linkedin.com 没登录时会把 JD 折叠起来，bookmarklet 抓不全。LinkedIn 自己有一套免登录接口，`tools/linkedin-jobs.mjs` 直接读它：

```bash
npm run linkedin -- <岗位链接或 ID> [...]            # 取 JD，存进 inbox/，和 bookmarklet 捕获的格式一样
npm run linkedin -- search "AI Agent" --city 上海 --days 7 --pages 2   # 搜索，列出 ID / 标题 / 公司 / 城市
npm run linkedin -- search "后端" --city 北京 --fetch              # 搜索结果全部存进 inbox/
```

- 岗位 ID 就是 `/jobs/view/…-1234567890` 末尾那串数字
- `/jobs/search?…&trk=missing_jd_redirect` 这种搜索页链接说明原岗位已下线，没有 ID 可取
- `--city` 认中文城市名（上海 / 苏州 / 杭州 / 南京 / 无锡 等），其他城市写拼音
- 输出里标「↪ 转载自其他招聘站」的，JD 是从猎聘等平台同步过来的，挂名公司不一定是实际用人方
- 请求逐条发、间隔 1.5 秒，搜索最多 5 页 —— 用来代替手动翻页，不是用来批量爬

## 腾讯招聘：一次拉一整个搜索结果

careers.tencent.com 是 SPA，背后是公开的 JSON 接口，搜索页上的筛选条件能原样对上接口参数。`tools/tencent-careers.mjs` 直接调接口：

```bash
npm run tencent -- "<careers.tencent.com/search.html?query=...&keyword=... 链接>" --days 30   # 只列出
npm run tencent -- agent --city 上海,北京 --days 30 --fetch                                  # 存进 inbox/
```

- 在网页上把筛选调好，直接复制地址栏的链接传进来就行（`ot_` 是职类，`ci_` 是城市，`bg_` 是事业群）
- `--days` 按「最后更新时间」过滤，接口不提供单独的发布日期
- `--fetch` 会跳过 inbox/ 和 inbox/processed/ 里已经抓过的岗位，重复跑只会补新的
- 关键词是全文匹配，「agent」会带出游戏测试、客户端这类只是 JD 里提到 Agent 的岗位，交给 inbox 的标题过滤去筛

## 常见问题

**Q: 弹窗说"❌ 服务器没启动"**
A: 先跑 `node tools/jd-inbox-server.mjs`。

**Q: Boss 直聘点了 bookmarklet 但抽到的内容不对 / 太少**
A: 确保你已经登录 Boss + 完整看到 JD（拉到底部）再点。Boss 有时会懒加载详情。

**Q: Mokahr 抽到的是 iframe 外壳，没有 JD 内容**
A: Mokahr 多数嵌在公司主域名的 iframe 里，跨域 → 无法读取。**右键 iframe → 在新 tab 打开 iframe URL**，然后再点 Mokahr bookmarklet。

**Q: 公众号文章 / 小红书笔记里的 JD 抓不到**
A: 微信/小红书 ToC 端 DOM 经过加密 / 反爬，bookmarklet 不能搞。请用截图给 Claude。

**Q: 怎么知道服务器收到了？**
A: 启动服务器的终端会实时打印每次收到的 payload（platform、URL、文本长度）。

**Q: 想看 inbox 里有什么？**
A: `ls -lt inbox/*.json` 看时间倒序的待处理文件，或 `cat inbox/{文件名}` 看 JSON 内容。

**Q: 想自己改某个 bookmarklet 的 selector？**
A: 编辑 `tools/bookmarklets/{name}.js`，重跑 `npm run build-bookmarklets`，再次拖到书签栏（覆盖旧版）。

## 安全 & 隐私

- 服务器只监听 `127.0.0.1`（localhost），外网访问不到
- inbox/*.json 是你的本地 JD 数据，已 gitignore
- bookmarklet 不会发送任何数据到 Claude / Anthropic / 第三方，**只发到你自己的 localhost**

## 文件清单

```
tools/
├── jd-inbox-server.mjs          # 本地 HTTP 服务器（端口 8787）
├── build-bookmarklets.mjs       # 生成 install.html
├── linkedin-jobs.mjs            # LinkedIn 取 JD / 搜岗（npm run linkedin）
├── tencent-careers.mjs          # 腾讯招聘整页拉取（npm run tencent）
├── install.html                 # 浏览器打开拖按钮（自动生成）
├── README.md                    # 本文件
└── bookmarklets/
    ├── universal.js             # 通用
    ├── boss-zhipin.js           # Boss 直聘
    ├── liepin.js                # 猎聘
    ├── lagou.js                 # 拉勾
    ├── mokahr.js                # Mokahr ATS
    └── dachang-spa.js           # 大厂 careers SPA

inbox/                           # bookmarklet 写入的 JSON 落地（gitignored）
├── jd-{ts}-{platform}-{slug}.json
└── processed/                   # Claude 处理完移到这里
```
