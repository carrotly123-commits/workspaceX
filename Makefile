# ============================================================
# Playground Monorepo — Unified Orchestration Makefile
# ============================================================

-include .env
export

PLATFORM ?= deepseek
MODE ?= semi
COUNT ?= 1
EMAIL_PROVIDER ?= $(or $(UR_EMAIL_PROVIDER),mailhub)

.PHONY: help install-ai chrome mail-hub gateway doctor platforms register capture list export

help:
	@echo ""
	@echo "=== AI 自动化套件快捷命令 (mail-hub -> universal-registrar -> token-free-gateway) ==="
	@echo "  make install-ai                           安装三个 AI 套件项目的依赖"
	@echo "  make chrome                               启动带远程调试端口(9222)的 Chrome"
	@echo "  make mail-hub                             启动临时邮箱聚合服务 Mail Hub (默认 :3100)"
	@echo "  make gateway                              启动免 Token API 网关 Token-Free Gateway (默认 :3456)"
	@echo "  make doctor                               一键体检 Chrome CDP / Mail Hub / Gateway 连通性"
	@echo "  make platforms                            列出支持自动注册/采集的 13+ AI 平台"
	@echo "  make register PLATFORM=deepseek           使用 $(EMAIL_PROVIDER) 邮箱自动/半自动注册指定平台"
	@echo "  make capture PLATFORM=claude              从已登录浏览器采集指定平台的 Session 并导出至网关"
	@echo "  make list                                 查看已保存的注册账号列表"
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

register:
	cd universal-registrar && npx tsx src/index.ts register $(PLATFORM) --mode $(MODE) --count $(COUNT) --email-provider $(EMAIL_PROVIDER)

capture:
	cd universal-registrar && npx tsx src/index.ts capture $(PLATFORM)

list:
	cd universal-registrar && npx tsx src/index.ts list

export:
	cd universal-registrar && npx tsx src/index.ts export
