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
