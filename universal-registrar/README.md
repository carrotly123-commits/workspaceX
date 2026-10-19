# Universal Registrar

面向 [token-free-gateway](https://github.com/andeya/token-free-gateway) 生态的 **通用多平台注册机**。

用插件化适配器驱动 Chrome（CDP / Playwright），在各类 AI Web 平台上完成：

1. 注册 / 登录（自动填表 + 人机协作验证码/短信）
2. 抓取会话凭证（cookie / token）
3. 写入 `~/.token-free-gateway/auth-profiles.json`，网关可直接使用

> **合规说明**  
> 本工具设计给个人测试与自己的账号管理使用。请遵守各平台服务条款与当地法律。  
> 批量滥用免费额度、绕过风控、买卖账号等行为不在支持范围内；引擎默认单线程，单批最多 20 个。

---

## 功能概览

| 能力 | 说明 |
| --- | --- |
| **外部网站发现 (`discover`)** | 从种子 URL、聚合导航页（`--crawl`）、Markdown/HTML/文本文件中自动提取外部 AI 网站，探测框架指纹（OneAPI / NewAPI / VoAPI / Supabase / Clerk / NextAuth / Generic AI）及注册入口 |
| **注册途径探测 (`probe`)** | 自动探测网站支持的所有注册途径（`api_oneapi`、`api_rest`、`browser_email_direct`、`browser_email_otp`、`browser_phone_sms`、`oauth_only`）、验证码阻碍与 DOM 选择器 |
| **最优方案决策 (`plan`)** | 对探测到的注册途径量化评分（0–100），优先选择纯 HTTP 协议级注册或免验证浏览器自动流，自动生成最优并发与平台配置 |
| **高并发批量注册 (`register` / `pipeline`)** | 支持并发工作池（`--concurrency`）、失败自动换新邮箱重试（`--retries`）、浏览器域名级 Cookie/Storage 隔离、多邮箱源自动故障转移（MailHub → Mail.tm → File） |
| **2API 有意义凭证提取与铸造 (`credentials`)** | 实时网络流量嗅探 + WebStorage 深度解析 + 自动请求 `/api/token/` 铸造 `sk-...` API Key，导出包含 `apiKey`、`accessToken`、`readyHeaders` 的 JSON / Keys / JSONL / `.env` |
| 13+ 内置平台 | 与 token-free-gateway 对齐：Claude / ChatGPT / DeepSeek / 豆包 / Gemini / GLM / GLM Intl / Grok / Kimi / Perplexity / 千问 / 通义 / 小米 MiMo |
| 三种模式 | `auto` 全自动 · `semi` 自动填表+人工验证 · `manual` 纯人工，只负责抓会话 |
| 邮箱 | `auto` 智能多源故障转移 · `mailhub` 邮箱中心 · `mailtm` 临时邮箱 API · `file` 邮箱池 · `manual` 人工 |
| 凭证导出 | 一键导出 2API 专用凭证包（`credentials-2api.json` / `keys.txt`）及 token-free-gateway `auth-profiles.json` |
| 自定义平台 | `config/platforms/*.json` 零代码扩展 |

---

## 环境要求

- Node.js 20+（或 [Bun](https://bun.sh/)）
- Google Chrome / Chromium（需开启远程调试端口）
- 可选：已安装的 `token-free-gateway`

```bash
cd universal-registrar
npm install
```

---

## 快速开始

### 1. 启动带调试端口的 Chrome

```bash
# 若已安装 token-free-gateway：
token-free-gateway chrome start

# 或手动（Windows PowerShell）：
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\chrome-ur-debug"
```

检查连通性：

```bash
npm run doctor
# 或: npx tsx src/index.ts doctor
```

### 2. 查看支持的平台

```bash
npm run platforms
```

### 3. 注册 / 捕获会话

```bash
# 全链路一键流水线：外部网站发现 -> 探测注册途径 -> 选择最优注册方案 -> 批量并发注册 -> 导出每个账号的 sk- Key / Token
npx tsx src/index.ts pipeline https://your-ai-site.com --count 20 --concurrency 5 --out ./credentials-2api.json

# 分步执行：
# 1) 外部发现网站（支持目录页爬取 --crawl 或本地列表文件）
npx tsx src/index.ts discover https://ai-directory.example.com --crawl
# 2) 探测目标网站的注册途径、验证码阻碍与选择器
npx tsx src/index.ts probe https://your-ai-site.com
# 3) 评估并选择最优注册方案（可加 --save-platform 保存配置）
npx tsx src/index.ts plan https://your-ai-site.com --save-platform
# 4) 大量注册（支持 --auto-plan 自动选优、--concurrency 并发、--retries 失败自动换邮箱重试）
npx tsx src/index.ts register https://your-ai-site.com --count 50 --concurrency 5 --auto-plan
# 5) 导出有意义的 2API 凭证（支持 json / keys / jsonl / env 格式）
npx tsx src/index.ts credentials --format json --out ./credentials-2api.json
npx tsx src/index.ts credentials --format keys --out ./keys.txt

# DeepSeek：半自动（自动填邮箱密码，验证码/人机你来处理）
npx tsx src/index.ts register deepseek --mode semi

# 指定邮箱密码
npx tsx src/index.ts register deepseek --email you@domain.com --password "YourStr0ng!Pass"

# Claude / ChatGPT / Gemini / Grok：建议只捕获已登录会话
npx tsx src/index.ts capture claude
npx tsx src/index.ts capture chatgpt
npx tsx src/index.ts capture gemini
npx tsx src/index.ts capture grok

# Kimi 等强依赖手机号的平台
npx tsx src/index.ts register kimi --phone +8613800138000 --mode semi
```

成功后默认会把凭证写入：

```
~/.token-free-gateway/auth-profiles.json
```

然后：

```bash
token-free-gateway start
# 客户端 base_url → http://localhost:3456/v1
```

### 4. 查看与导出

```bash
npx tsx src/index.ts list
npx tsx src/index.ts export
npx tsx src/index.ts export --platform deepseek
```

---

## 注册模式怎么选

| 平台 | 推荐模式 | 原因 |
| --- | --- | --- |
| DeepSeek / Qwen Intl / GLM Intl / Perplexity | `semi` | 邮箱表单较标准，验证码可粘贴 |
| Kimi / 豆包 / 智谱 / 通义 / MiMo | `semi` 或 `manual` | 常要手机短信 |
| Claude / ChatGPT / Gemini / Grok | `manual` / `capture` | OAuth + 强风控，自动注册不稳定 |

`semi` 流程：

```
打开注册页 → 自动填邮箱/密码 → 你在浏览器里过验证码/短信
→ 回车确认 → 抓 cookie/token → 写入 TFG
```

---

## 邮箱提供方

```bash
# 默认：终端里粘贴验证码或整封邮件
--email-provider manual

# Mail Hub 聚合邮箱服务（推荐：支持 Outlook / IMAP / YYDS / 10+ 临时邮箱自动调度与验证码提取）
--email-provider mailhub --mailhub-url http://127.0.0.1:3100 --mailhub-key your-secret

# 邮箱池文件（每行一个邮箱，验证码仍需人工或配合 IMAP 自扩展）
--email-provider file --email-file ./config/emails.txt

# mail.tm 临时邮箱（多数大厂会拒收，仅适合宽松站点）
--email-provider mailtm
```

---

## 自定义平台（JSON 插件）

把定义放到 `config/platforms/your-site.json`（可参考 `example.json.sample`）：

```json
{
  "id": "your-site",
  "name": "Your Site",
  "signupUrl": "https://example.com/signup",
  "domains": ["example.com"],
  "preferredMode": "semi",
  "needsEmail": true,
  "needsPhone": false,
  "selectors": {
    "openSignup": ["a[href*='signup']"],
    "email": ["#email"],
    "password": ["#password"],
    "submit": ["button[type='submit']"],
    "code": ["input[name='code']"]
  },
  "successCookie": "session"
}
```

也可用 TypeScript 实现 `PlatformAdapter` 接口（见 `src/platforms/base.ts`），在 `registry.ts` 注册。

---

## 目录结构

```
universal-registrar/
├── config/
│   ├── config.example.json
│   ├── emails.example.txt
│   └── platforms/          # JSON 自定义平台
├── src/
│   ├── index.ts            # CLI
│   ├── core/
│   │   ├── engine.ts       # 注册引擎
│   │   ├── browser.ts      # CDP 连接
│   │   ├── account-store.ts
│   │   ├── types.ts
│   │   └── email/          # manual / file / mailtm
│   ├── platforms/          # 各平台适配器
│   └── export/tfg.ts       # 导出到 token-free-gateway
└── package.json
```

---

## 配置

优先级：CLI 参数 > 环境变量 > `config/config.json` > `~/.universal-registrar/config.json` > 默认值

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `cdpUrl` | `http://127.0.0.1:9222` | Chrome 调试地址 |
| `emailProvider` | `manual` | 邮箱来源 |
| `delayBetweenMs` | `5000` | 批量间隔 |
| `storePath` | `~/.universal-registrar/accounts.json` | 账号库 |
| `tfgStorePath` | `~/.token-free-gateway/auth-profiles.json` | 网关凭证 |

---

## 和 token-free-gateway 的关系

```
universal-registrar          token-free-gateway
─────────────────            ──────────────────
register / capture    ──►    auth-profiles.json
                             webauth（也可继续用官方向导）
                             serve / start
                                  │
                                  ▼
                           OpenAI 兼容 /v1/chat/completions
```

本工具补齐「还没有账号」这一步；网关补齐「有会话之后当 API 用」。  
若账号已存在，只需：

```bash
npx tsx src/index.ts capture <platform>
# 等价于更偏注册向的 webauth 会话采集
```

---

## 常见问题

**doctor 失败**  
Chrome 未开调试端口，或 9222 被占用。用独立 `--user-data-dir` 再启一个实例。

**注册成功但 hasCredentials=false**  
页面还没真正登录。确认浏览器里已进入对话页，再执行 `capture <platform>`。

**DeepSeek bearer 为空**  
保持 chat 页打开，重新 `capture deepseek`；TFG 的 deepseek 客户端有时也能在后续请求里补 token。

**批量被风控**  
降低频率、换真实邮箱、使用 `manual`，不要上指纹浏览器农场式并发（本项目故意限制 concurrency=1）。

---

## License

MIT — 请负责任地使用。
