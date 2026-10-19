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
| 13+ 内置平台 | 与 token-free-gateway 对齐：Claude / ChatGPT / DeepSeek / 豆包 / Gemini / GLM / GLM Intl / Grok / Kimi / Perplexity / 千问 / 通义 / 小米 MiMo |
| 三种模式 | `auto` 全自动 · `semi` 自动填表+人工验证 · `manual` 纯人工，只负责抓会话 |
| 邮箱 | `manual` 粘贴验证码 · `file` 邮箱池 · `mailtm` 临时邮箱 API |
| 凭证导出 | 一键写入 token-free-gateway 的 `auth-profiles.json` |
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

### 检查页面与验证登录

```bash
npx tsx src/index.ts inspect https://chat.example.com/login
npx tsx src/index.ts verify https://chat.example.com --success-cookie session
# 或者使用只在登录后可见的选择器
npx tsx src/index.ts verify https://chat.example.com --success-selector '[data-testid="account-menu"]'
```

- `inspect <platform|url>` 只报告页面候选项数量及歧义，不读取或输出凭据。它不能发现网站实际 API 或模型能力。
- `verify <platform|url>` 只检查浏览器中已打开的目标标签页；不会捕获会话或导出凭据。必须配置 `--success-cookie <cookie名称>` 和/或 `--success-selector <CSS选择器>`。Cookie 按精确名称、非空且未过期匹配，支持 HttpOnly；选择器须匹配可见元素。若两项都配置，则两项都必须通过。
- 通用站点需配置登录成功证明。建议用非分析类、确实仅登录后存在的 Cookie，或登录后专属且可见的元素；不要用通用 `body`。缺少证明或验证失败时应视为 `unverified`，不导出。Cookie 命中只证明配置的登录信号存在，不证明网关连通或模型可用。
- `capture` 面向浏览器中已有的登录会话，不会替你创建邮箱。

### GitHub OAuth（现有账号）

```bash
npx tsx src/index.ts register https://chat.example.com/signup --auth github --email existing-label --success-cookie actual_cookie --save-platform --mode semi --count 1
```

这是通过 GitHub 登录目标网站的单账号半自动流程。你必须在浏览器中手动登录已有 GitHub 用户并完成授权/同意；它不会创建 GitHub 账号。`--email existing-label` 是本地账号标签示例，也可填写你的已有账号邮箱；不会申请新邮箱或生成 GitHub 密码。入口缺失或有多个候选项时会停止并提示人工处理。`actual_cookie` 必须替换为目标站点的真实登录 Cookie 名称。

严格证据校验覆盖通用适配器（URL、自定义配置和 GitHub 路径）；部分旧内置适配器的 `capture` 仍使用原有采集逻辑，不能据此推断已验证登录。共享注册流程已有的成功检测返回失败时，现在也会阻断采集。

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

### 回归验证

```bash
npm test
npm run typecheck
# 可选：在本地调试浏览器中运行受控页面回归（不访问真实 GitHub）
UR_TEST_CDP_URL=http://127.0.0.1:9222 UR_TEST_ORIGIN=http://127.0.0.1:3456 npm test
```

默认测试跳过浏览器用例；设置上述两个变量后，测试模拟 GitHub 入口、当前页/弹窗回调、歧义和登录证据失败。它不证明真实网站的 OAuth 授权或模型调用成功。

### 前端报告查看（#2 输出格式）

启动 Token-Free Gateway 后，从控制台顶部的「注册报告」进入 `/registrar`。该页面是独立于渠道管理的本地只读报告查看器，不需要先把账号导入网关。

- 支持发现数组或 `discovered-sites.json`、单份 probe/plan JSON、pipeline 的精简摘要、`accounts.json` 和 `credentials-2api.json`。
- 页面按发现、探测、策略、注册结果、凭证摘要分阶段展示；pipeline 的汇总数量不冒充逐条明细，策略评分和凭证质量评级不代表实际调用成功。
- 文件只在浏览器内解析，不上传、不持久化。邮箱、密码、密钥、Token、请求头和 URL 路径不展示。可下载脱敏审阅摘要，但它不能替代原始凭证备份。
- 每次导入替换当前报告；限制为 5 MB、2,000 条展示记录。CLI 的进度日志可能混在 stdout 中，导入时请仅提供完整 JSON；不支持 JSONL、keys 或 env 格式。
- #2 没有任务控制 HTTP API，本页不启动注册、不签发凭证、不连接外部网站，也不自动挂载网关渠道。
