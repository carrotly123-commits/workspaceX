# playground

本仓库汇总并归档了以下 6 个核心项目：

## 项目目录总览

| 目录 | 名称 | 技术栈 | 说明 |
| :--- | :--- | :--- | :--- |
| [`mail-hub/`](./mail-hub) | **Mail Hub** | TypeScript / Node.js / Hono / SQLite | 多渠道临时邮箱聚合服务，提供统一的 REST API、收件轮询、验证码智能提取与 Web 管理面板（默认端口 `3100`）。 |
| [`universal-registrar/`](./universal-registrar) | **Universal Registrar** | TypeScript / Node.js / Playwright | 插件化多平台（13+ AI 平台）自动/半自动账号注册与浏览器 Session 采集工具，可对接 `mail-hub` 收码并将凭证导出至 `token-free-gateway`。 |
| [`token-free-gateway/`](./token-free-gateway) | **Token-Free Gateway** | TypeScript / Bun / Playwright | 基于浏览器网页端 AI 会话的免 Token OpenAI 兼容 API 网关，支持 13+ 平台流式输出与工具调用（默认端口 `3456`）。 |
| [`wa-app/`](./wa-app) | **WA-App** | Go / gRPC / SQLite / PostgreSQL | WhatsApp 账号与设备配置管理、注册探测、会话维持、消息收发及 Web 控制台工程底座。 |
| [`open-reverselab/`](./open-reverselab) | **Open-ReverseLab** | Python / MCP / Security KB | 面向 Agent 的逆向工程与安全分析实验室，内置 178 篇结构化知识库、四大分析板块（Android / Windows / Web CTF / 通用安全）及 100+ MCP 工具集成。 |
| [`ruyipage/`](./ruyipage) | **ruyiPage** | Python / Firefox WebDriver BiDi | 基于 Firefox 与 WebDriver BiDi 的同步/异步浏览器自动化、网络抓包拦截与指纹管理 Python 库。 |

## 联动链路说明（AI 账号注册与免 Token 网关）

1. **`mail-hub`**：启动临时邮箱聚合服务，为自动注册提供邮箱分配与验证码提取接口。
2. **`universal-registrar`**：调用浏览器与邮箱服务完成各 AI 平台注册或登录，并将采集到的会话凭证写入 `~/.token-free-gateway/auth-profiles.json`。
3. **`token-free-gateway`**：加载 `auth-profiles.json` 并通过 CDP 驱动浏览器会话，对外暴露统一的 `/v1/chat/completions` OpenAI 兼容接口。

各子项目的详细安装、配置与运行方式请参考对应子目录下的 `README.md`。
