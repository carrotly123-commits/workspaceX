# WorkspaceX — 多渠道 AI 账号自动化注册、接码聚合与免 Token 网关套件

> 📖 **新手 / 非技术用户请直接阅读保姆级图文式指南：[`NOOBREADME2.md`](./NOOBREADME2.md)**

本仓库是一个面向 Web AI 渠道自动化接入与逆向自动化的工程 Monorepo，核心由 **AI 免 Token 闭环套件（`mail-hub` + `universal-registrar` + `token-free-gateway`）** 以及三个专项工程底座（`wa-app`、`open-reverselab`、`ruyipage`）组成。

---

## 一、系统架构与工作流全景

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                        AI 免 Token 全渠道自动化闭环                          │
├───────────────────────┬──────────────────────────┬──────────────────────────┤
│   1. Mail Hub (:3100) │ 2. Universal Registrar   │ 3. Token-Free Gateway    │
│   临时邮箱与接码中心   │  全渠道自动注册/会话采集   │  OpenAI 兼容 API 网关    │
├───────────────────────┼──────────────────────────┼──────────────────────────┤
│ • 聚合 Mail.tm/Temp   │ • 内置 13 大 AI 平台适配   │ • 标准 /v1/chat/completions│
│   Mail/Outlook/IMAP   │ • 任意新网站 URL 即填即用  │ • 任意新渠道自动发现挂载  │
│ • 智能验证码正则提取   │ • 多步向导式表单自动探测   │ • 多账号池 Round-Robin   │
│ • 域名封禁自学习与轮换 │ • 拟人鼠标轨迹 & 过盾恢复  │ • 401/429 自动故障转移   │
│ • 极速取码 Web 控制台  │ • Cookie + Storage 全采集 │ • 低延迟流式 Tool Calling│
└───────────┬───────────┴────────────┬─────────────┴────────────┬─────────────┘
            │  分配邮箱 & 轮询验证码   │  导出多账号凭证池         │
            └───────────────────────►├─────────────────────────►│ (:3456 Web UI & API)
                                     │ ~/.token-free-gateway/   │ 供 Cursor / NextChat /
                                     │   auth-profiles.json     │ Cherry Studio / SDK 调用
```

### 六大子项目总览

| 目录 | 项目名称 | 技术栈 | 默认端口 | 核心职责 |
| :--- | :--- | :--- | :--- | :--- |
| [`mail-hub/`](./mail-hub) | **Mail Hub** | TypeScript / Node.js / Hono / SQLite | `3100` | 多渠道临时邮箱聚合服务，支持自动择优调度、收件轮询、验证码提取、域名信誉反馈与 Web 极速取码工作台。 |
| [`universal-registrar/`](./universal-registrar) | **Universal Registrar** | TypeScript / Node.js / Playwright | CLI | 插件化 + 零配置通用 AI 平台账号注册与浏览器 Session 采集引擎，支持内置 13 平台及**任意新渠道 URL 直接输入即用**。 |
| [`token-free-gateway/`](./token-free-gateway) | **Token-Free Gateway** | TypeScript / Bun / Playwright | `3456` | 将浏览器网页端 AI 会话转化为标准 OpenAI `/v1/chat/completions` 接口，内置多账号池轮询、自动故障转移、流式 Tool Calling 与可视化 Web 控制台。 |
| [`wa-app/`](./wa-app) | **WA-App** | Go / gRPC / SQLite / PostgreSQL / React | `8080` / `50091` | WhatsApp 账号与设备指纹管理、注册探测、会话维持、消息收发及 Web 控制台。 |
| [`open-reverselab/`](./open-reverselab) | **Open-ReverseLab** | Python / MCP / Security KB | MCP | 面向 Agent 的逆向工程与安全分析实验室，内置 178 篇结构化知识库与 100+ MCP 工具集成。 |
| [`ruyipage/`](./ruyipage) | **ruyiPage** | Python / Firefox WebDriver BiDi | SDK | 基于 Firefox 与 WebDriver BiDi 的同步/异步浏览器自动化、网络抓包拦截与指纹管理库。 |

---

## 二、核心特性详解

### 1. 不局限于内置平台：任意新渠道“输入即用”（Zero-Config Onboarding）
- **内置 13 大主流 AI 渠道**：`deepseek`、`claude`、`chatgpt`、`gemini`、`qwen`、`qwen-cn`、`doubao`、`kimi`、`glm`、`glm-intl`、`grok`、`perplexity`、`xiaomimo`。
- **任意新网站 URL 直接输入即用**：
  - 在 `universal-registrar` 中直接传入任意新发现的 AI 网站 URL 或域名（如 `https://chat.example.com/signup`），引擎自动推导渠道 ID、主域、Cookie 域与对话地址；
  - 支持**多步向导式注册表单**（例如 Step 1 输入邮箱点下一步 → Step 2 输入密码 → Step 3 填写邮箱验证码）；
  - 自动采集 `Cookie` + `localStorage` / `sessionStorage` 中的认证 Token，并连同渠道元数据写入 `~/.token-free-gateway/auth-profiles.json`；
  - `token-free-gateway` 启动或收到请求时，**自动发现并挂载** `auth-profiles.json` 中的新渠道，通过 `GenericDomClient` 驱动网页对话框，无需编写一行 TypeScript 代码即可通过 `model: "<渠道ID>"` 调用。

### 2. 多账号池（Account Pool）负载均衡与自动故障转移（Failover）
- **单渠道多账号并存**：同一渠道多次注册或导入不同邮箱/Cookie 时，凭证自动归入 `profile.accounts` 账号池，不再相互覆盖。
- **Round-Robin 轮询调度**：网关对同一渠道下的多个健康账号采用轮询分发，分摊单号请求频率。
- **自动冷却与故障转移**：当某个账号触发 `401 SessionExpired`、`403` 或 `429 Rate Limit` 时，自动将该账号标记为冷却状态（默认 60s）并透明切换至池中下一个可用账号重试。
- **同域页面互斥锁（Page Mutex）**：内置 `BrowserManager.withPageLock`，保证并发请求同一 DOM 渠道时排队执行，杜绝多请求在同一浏览器标签页中串话。

### 3. 拟人化抗风控与流式工具调用（Streaming Tool Calling）
- **拟人化交互与自动过盾**：内置贝塞尔曲线拟人鼠标轨迹（`humanMoveTo` / `humanClickBox`）、逐字变速键盘输入，自动检测 Cloudflare Turnstile、hCaptcha、reCAPTCHA、GeeTest 滑块并在人工/自动完成后无缝恢复后续填表流程。
- **零延迟流式 Tool Calling 状态机（`StreamingToolCallFilter`）**：在开启 `stream: true` 且携带 `tools` 时，普通回答文本实时以 SSE chunk 流式透传（极低 TTFT），仅在命中 `<tool_call`、```` ```tool_json ```` 或 `{"tool":` 前缀时精准拦截并解析为标准 OpenAI `tool_calls` delta。

---

## 三、环境要求与快速部署

### 1. 环境依赖
- **Node.js** `>= 20.0.0`（用于运行 `mail-hub` 与 `universal-registrar`）
- **Bun** `>= 1.1.0`（用于运行 `token-free-gateway`）
- **Google Chrome / Chromium**（本机安装，通过 CDP 远程调试端口 `9222` 连接）

### 2. 一键安装与启动（根目录 `Makefile`）

```bash
# 1. 复制环境变量配置（包含 MAIL_HUB_API_KEY / API_SECRET 等）
cp .env.example .env

# 2. 安装三大核心模块依赖
make install-ai

# 3. 启动带远程调试端口 (127.0.0.1:9222) 的 Chrome 浏览器
make chrome

# 4. 启动临时邮箱中心 Mail Hub (http://127.0.0.1:3100)
make mail-hub

# 5. 启动免 Token 网关 Token-Free Gateway (http://127.0.0.1:3456)
make gateway

# 6. 一键检查 Chrome CDP + Mail Hub + Gateway 三端连通性
make doctor
```

---

## 四、使用指南：内置渠道与任意新渠道接入

### 方式 A：通过 Web 可视化控制台直接操作（推荐）
1. **Token-Free Gateway 控制台**：浏览器打开 **`http://127.0.0.1:3456/`**
   - 在左栏 **“① 填入新渠道 / 追加账号池”** 中，选择内置渠道或直接粘贴任意新 AI 网站网址（如 `https://chat.example.com`）与 Cookie，点击 **“保存并立即挂载”**；
   - 在中栏查看所有已激活渠道、模型标签与多账号池状态；
   - 在右栏 **“③ 在线对话测试 (Playground)”** 中点击模型标签即可实时测试流式对话。
2. **Mail Hub 邮箱与极速取码中心**：浏览器打开 **`http://127.0.0.1:3100/`**
   - 使用 `.env` 中的 `API_SECRET` 登录后，首页顶部即为 **“⚡ 三步极速取码工作台”**，一键生成临时邮箱、点击复制邮箱地址、一键提取最新 6 位验证码。

### 方式 B：通过 CLI 自动/半自动注册或采集会话

```bash
# 1. 查看所有已注册的平台列表
make platforms

# 2. 注册内置平台（使用 Mail Hub 自动分配邮箱并提取验证码）
make register PLATFORM=deepseek MODE=semi

# 3. 批量注册多个账号并自动汇入同一渠道的多账号轮询池（最多 20 个/批）
make register PLATFORM=deepseek COUNT=3

# 4. 从已登录的浏览器窗口直接采集 Session（免注册）
make capture PLATFORM=claude

# 5. 【新渠道即输即用】直接传入任意未知 AI 网站的注册/登录网址！
cd universal-registrar
npx tsx src/index.ts register https://chat.example.com/signup
# 或指定自定义渠道 ID 并保存为持久化配置 config/platforms/my-ai.json：
npx tsx src/index.ts capture my-ai --url https://chat.example.com/login --chat-url https://chat.example.com --save-platform
```

### 方式 C：通过 JSON 配置文件精细定义新渠道
- **注册端配置（可选）**：在 `universal-registrar/config/platforms/<id>.json` 中定义表单选择器（参考 `example.json.sample`）。
- **网关端配置（可选）**：在 `~/.token-free-gateway/providers/<id>.json`（或通过环境变量 `TFG_PROVIDERS_DIR` 指定目录）放置 JSON：

```json
{
  "id": "my-custom-ai",
  "name": "My Custom AI",
  "startUrl": "https://chat.example.com",
  "cookieDomain": ".example.com",
  "models": [
    { "id": "my-custom-ai", "name": "My Custom AI Default" }
  ],
  "selectors": {
    "input": ["textarea", "div[contenteditable=\"true\"]"],
    "submit": ["button[type=\"submit\"]"],
    "response": ["[data-message-author-role=\"assistant\"]", ".markdown-body"]
  }
}
```

---

## 五、OpenAI 兼容 API 调用示例

网关启动后默认监听 `http://127.0.0.1:3456/v1`，兼容所有标准 OpenAI SDK 与客户端（Cursor、NextChat、Cherry Studio、LobeChat 等）。

### 1. 查询已激活模型列表
```bash
curl http://127.0.0.1:3456/v1/models
```

### 2. 发起流式对话（支持模型名、`渠道ID/模型名` 或直接传 `渠道ID`）
```bash
curl http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any-key" \
  -d '{
    "model": "deepseek-chat",
    "stream": true,
    "messages": [
      { "role": "user", "content": "用三句话解释什么是量子纠缠" }
    ]
  }'
```

### 3. 流式工具调用（Function / Tool Calling）
```bash
curl http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "stream": true,
    "messages": [{ "role": "user", "content": "帮我查看当前目录下的文件" }],
    "tools": [{
      "type": "function",
      "function": {
        "name": "list_dir",
        "description": "列出指定目录中的文件",
        "parameters": {
          "type": "object",
          "properties": { "path": { "type": "string" } },
          "required": ["path"]
        }
      }
    }]
  }'
```

---

## 六、环境变量与配置说明

| 变量名 | 所属模块 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `PORT` / `HOST` | `mail-hub` | `3100` / `127.0.0.1` | Mail Hub 监听端口与绑定地址 |
| `API_SECRET` | `mail-hub` | *(必填)* | Mail Hub 管理员 Bearer 密钥（至少 16 位非占位字符） |
| `ENCRYPTION_KEY` | `mail-hub` | 自动派生 | 用于 SQLite 中加密存储第三方邮箱凭证的密钥 |
| `UR_CDP_URL` / `TFG_CDP_URL` | 注册器 / 网关 | `http://127.0.0.1:9222` | Chrome 远程调试地址 |
| `UR_EMAIL_PROVIDER` | `universal-registrar` | `manual` (`Makefile` 默认为 `mailhub`) | 邮箱来源：`mailhub` \| `mailtm` \| `file` \| `manual` |
| `MAIL_HUB_URL` / `MAIL_HUB_API_KEY` | `universal-registrar` | `http://127.0.0.1:3100` | 对接 Mail Hub 自动收码的地址与密钥 |
| `TFG_PORT` / `TFG_HOST` | `token-free-gateway` | `3456` / `127.0.0.1` | 网关监听端口与地址 |
| `TFG_API_KEY` | `token-free-gateway` | 空（本机免鉴权） | 设置后调用 `/v1/*` 需携带 `Authorization: Bearer <TFG_API_KEY>` |
| `TFG_STORE_PATH` | 注册器 / 网关 | `~/.token-free-gateway/auth-profiles.json` | 共享凭证与多账号池存储路径 |
| `TFG_PROVIDERS_DIR` | `token-free-gateway` | `~/.token-free-gateway/providers` | 自定义网关渠道 JSON 目录 |

---

## 七、开发测试与校验

```bash
# 运行 Universal Registrar 单元测试与类型检查
cd universal-registrar && npm test && npm run typecheck

# 运行 Token-Free Gateway 单元测试与类型检查
cd token-free-gateway && bun test && bun run typecheck

# 运行 Mail Hub 单元测试
cd mail-hub && npm test
```
