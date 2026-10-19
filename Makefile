# ============================================================
# Playground Monorepo — Unified Orchestration Makefile
# ============================================================

-include .env
export

PLATFORM ?= deepseek
MODE ?= semi
COUNT ?= 1
CONCURRENCY ?= 1
EMAIL_PROVIDER ?= $(or $(UR_EMAIL_PROVIDER),auto)

.PHONY: help install-ai chrome mail-hub gateway doctor platforms discover probe plan register pipeline capture list credentials export

help:
	@echo ""
	@echo "=== AI 自动化套件快捷命令 (mail-hub -> universal-registrar -> token-free-gateway) ==="
	@echo "  make install-ai                           安装三个 AI 套件项目的依赖"
	@echo "  make chrome                               启动带远程调试端口(9222)的 Chrome"
	@echo "  make mail-hub                             启动临时邮箱聚合服务 Mail Hub (默认 :3100)"
	@echo "  make gateway                              启动免 Token API 网关 Token-Free Gateway (默认 :3456)"
	@echo "  make doctor                               一键体检 Chrome CDP / Mail Hub / Gateway 连通性"
	@echo "  make platforms                            列出支持自动注册/采集的 13+ AI 平台"
	@echo "  make discover TARGET=<url|file>           发现外部 AI 网站并识别框架与注册入口"
	@echo "  make probe PLATFORM=<url|id>              探测网站所有注册途径、验证码阻碍与选择器"
	@echo "  make plan PLATFORM=<url|id>               评估并选择最优注册方案 (API协议 / 浏览器自动)"
	@echo "  make register PLATFORM=deepseek           使用 $(EMAIL_PROVIDER) 邮箱注册内置平台或任意新网址"
	@echo "  make pipeline TARGET=<url|file> COUNT=10  全链路流水线: 发现->探测->选优->批量注册->导出Key/Token"
	@echo "  make capture PLATFORM=claude              从已登录浏览器采集内置平台或任意新网址的 Session"
	@echo "  make list                                 查看已保存的注册账号列表"
	@echo "  make credentials                          导出可直接用于自写 2API 的 Key/Token/Headers 凭证"
	@echo "  make export                               将账号凭证同步导出至 Token-Free Gateway"
	@echo ""

install-ai:
	cd mail-hub && npm install
	cd universal-registrar && npm install
	cd token-free-gateway && bun install

chrome:
	cd token-free-gateway && bun index.ts chrome start

mail-hub:
	cd mail-hub && npm run dev

gateway:
	cd token-free-gateway && bun index.ts serve

doctor:
	cd universal-registrar && npx tsx src/index.ts doctor

platforms:
	cd universal-registrar && npx tsx src/index.ts platforms

discover:
	cd universal-registrar && npx tsx src/index.ts discover $(TARGET)

probe:
	cd universal-registrar && npx tsx src/index.ts probe $(PLATFORM)

plan:
	cd universal-registrar && npx tsx src/index.ts plan $(PLATFORM) --save-platform

register:
	cd universal-registrar && npx tsx src/index.ts register $(PLATFORM) --mode $(MODE) --count $(COUNT) --concurrency $(CONCURRENCY) --email-provider $(EMAIL_PROVIDER)

pipeline:
	cd universal-registrar && npx tsx src/index.ts pipeline $(TARGET) --count $(COUNT) --concurrency $(CONCURRENCY) --email-provider $(EMAIL_PROVIDER) --save-platform

capture:
	cd universal-registrar && npx tsx src/index.ts capture $(PLATFORM)

list:
	cd universal-registrar && npx tsx src/index.ts list

credentials:
	cd universal-registrar && npx tsx src/index.ts credentials

export:
	cd universal-registrar && npx tsx src/index.ts export
