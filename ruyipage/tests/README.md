# 测试体系说明

本目录用于承载 `ruyiPage` 的正式回归测试基线。

设计目标：

- 稳定可重复：优先使用本地 server、本地 HTML 页面和可控输入
- 分层清晰：按 smoke / feature / integration / release 组织
- 低侵入扩展：不替代 `examples/`，而是把回归断言沉淀在 `tests/`
- 服务 release：为后续版本发布、CI 和平台矩阵打基础

目录约定：

- `support/`：测试支撑代码，如本地 server、通用 helper、路径工具
- `fixtures/`：测试专用静态资源，如 HTML 页面
- `smoke/`：最核心的启动 / 导航 / 点击 / 输入能力
- `features/`：按模块划分的功能回归
- `integration/`：多模块串联后的工作流验证
- `release/`：发版前的最小通过集合

当前第一版基线已覆盖：

- 启动
- 导航
- 点击 / 输入
- 请求拦截
- 响应拦截与 response body
- DataCollector
- Cookie
- localStorage / sessionStorage
- Cookie + Storage 同会话联动流
- private mode
- attach 已有浏览器基础路径

## 快速开始

### 1. 安装测试依赖

```bash
python -m pip install -r requirements.txt
python -m pip install -r requirements-test.txt
```

### 2. 先运行快速测试

快速测试不启动真实 Firefox/BiDi，会覆盖异步 API 生成漂移、指纹构建、
runtime 安装器、配置生成和纯单元逻辑。日常改动建议先跑这一组。

```bash
python -m pytest -m fast -q
```

### 3. 准备浏览器

默认情况下，测试会直接使用系统默认路径下的 Firefox。

如果你希望显式指定浏览器路径，Windows 下请使用 PowerShell：

```powershell
$env:RUYIPAGE_TEST_FIREFOX_PATH="C:\Program Files\Mozilla Firefox\firefox.exe"
$env:RUYIPAGE_VERIFY_NATIVE_GEOMETRY="1"
python -m pytest tests/features/test_fingerprint_window_geometry.py -q
```

如果你本地使用的是配套的 `firefox-fingerprintBrowser` 151 版本 release，也可以把
这个环境变量指向它的 `firefox.exe`，这样整套 `tests/` 会直接跑在指纹浏览器上。

`RUYIPAGE_VERIFY_NATIVE_GEOMETRY=1` 只用于目标指纹 Firefox 的实机验证；如果你的
机器 DPI、缩放、主题或浏览器构建不同，16/93 的外窗/内窗差值可能会变化。

### 4. 运行全部基线

```bash
python -m pytest tests
```

### 5. 按层运行

```bash
python -m pytest tests/smoke -m browser -q
python -m pytest tests/features -m browser -q
python -m pytest tests/async_smoke/test_async_smoke.py -m browser -q
python -m pytest tests/integration -m browser -q
python -m pytest tests/release -m browser -q
```

### 6. 按 marker 运行

```bash
python -m pytest tests -m fast
python -m pytest tests -m browser
python -m pytest tests -m smoke
python -m pytest tests -m feature
python -m pytest tests -m integration
python -m pytest tests -m release
```

### 7. 常见使用顺序

- 日常改动后先跑：`python -m pytest -m fast -q`
- 需要真实浏览器验证时再跑：`tests/smoke -m browser`
- 功能改动后再跑：`tests/features -m browser`
- 涉及多模块联动时补跑：`tests/integration`
- 发版前至少跑：`tests/release`

运行方式：

```bash
python -m pytest tests
```

常用筛选：

```bash
python -m pytest -m fast -q
python -m pytest tests -m smoke
python -m pytest tests -m feature
python -m pytest tests -m integration
python -m pytest tests/release
```

说明：

- 第一阶段优先覆盖启动、导航、点击、输入、拦截、collector、Cookie、private mode 等核心路径。
- 现有 `examples/` 继续承担演示用途，不与 `tests/` 互相替代。

## 目录用法说明

### `tests/support/`

放测试支撑层代码，例如：

- 本地 HTTP mock server
- 路径与 helper
- 后续可能加入的日志收集、截图留档等测试工具

### `tests/fixtures/`

放测试专用静态资源，例如：

- 最小 HTML 页面
- 表单控件页
- storage / iframe / prompt / drag 等专项测试页

原则是：这些页面应服务“稳定断言”，而不是展示效果。

### `tests/smoke/`

最小回归集合，强调：

- 启动是否正常
- 导航是否正常
- 基础点击 / 输入是否正常

这层应该尽量快、尽量稳，适合开发中频繁执行。

### `tests/features/`

按模块划分的功能回归，适合验证：

- intercept
- cookies
- storage
- private mode
- attach

后续新增模块测试，优先放这里。

### `tests/integration/`

多模块组合后的工作流验证。

这层不追求覆盖全部 API，而是验证“多个模块串起来时还能正常工作”。

### `tests/release/`

发版前的最小通过集合。

这层测试应该：

- 数量少
- 信号强
- 尽量稳定
- 对用户最有感知

它的目标不是替代所有 feature 测试，而是给 release 一个清晰的质量门禁。

## Release Matrix

当前仓库已提供基础 CI 矩阵定义：`.github/workflows/tests.yml`

第一阶段矩阵策略：

- Python：3.9 / 3.10 / 3.11 / 3.12 / 3.13
- OS：Windows
- Firefox：151
- 浏览器模式：普通 Firefox 启动路径

CI 会通过环境变量 `RUYIPAGE_TEST_FIREFOX_PATH` 把指定 Firefox 路径注入到
`tests/conftest.py` 中的浏览器工厂，确保测试用例使用固定浏览器版本。

当前策略说明：

- CI 中默认使用官方 Firefox 151，原因是来源稳定、安装方式标准、最适合作为第一阶段回归基线。
- 如果做手工发版验证，推荐优先使用配套项目 `firefox-fingerprintBrowser` 的 151 版本 release：
  `https://github.com/LoseNine/firefox-fingerprintBrowser`
- 本地手工验证时，可以通过环境变量 `RUYIPAGE_TEST_FIREFOX_PATH` 指向该浏览器的可执行文件，
  让同一套 `tests/` 基线直接跑在指纹浏览器上。
- CI 当前会执行：`tests/smoke`、`tests/features`、`tests/integration`、`tests/release`

之所以先从这个范围起步，是为了优先建立稳定、可持续、可发版的最小质量门禁。

后续建议逐步扩展到：

- macOS / Linux
- `existing_only(True)` attach 模式的专门矩阵
- 指纹浏览器接管模式
- 特定 Firefox 版本分层验证

## 当前边界

这套基线已经能支撑“本地可重复 + release gate”目标，但还没有完全做到：

- 指纹浏览器接管矩阵自动化
- 多平台实机矩阵报告自动汇总
- Firefox 多版本并行验证
- `user_dir` 跨进程重启后的 localStorage 持久化，目前未纳入 release gate 硬断言

这些属于第二阶段稳定性建设内容。
