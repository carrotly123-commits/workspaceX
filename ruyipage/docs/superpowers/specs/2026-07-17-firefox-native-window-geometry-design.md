# Firefox Native Window Geometry Design

## Goal

修复智能指纹窗口和拖拽坐标问题，同时保持 Firefox 原生窗口几何与 WebDriver BiDi 输入语义，不通过 JavaScript、viewport override 或固定差值伪造浏览器状态。

## Native Geometry Contract

目标 Firefox 指纹浏览器的常规窗口由浏览器原生计算：

- `outerWidth - innerWidth == 16`
- `outerHeight - innerHeight == 93`

`16/93` 只用于实机回归断言，不进入生产坐标计算。元素坐标继续直接使用 `getBoundingClientRect()` 的 CSS viewport 坐标，不混入窗口边框、标题栏、屏幕偏移或 DPR。

## Fingerprint Startup

`apply_smart_fingerprint()` 默认只负责指纹数据：

- fpfile 删除 `width` / `height` 字段，创建后只做 screen override。
- 配置代理、userdir 和 fpfile。
- 不调用 `FirefoxOptions.set_window_size()`。
- 不调用 `window.normal()`、`resizeTo()`、`set_viewport()` 或 screen emulation。
- 不修改 `window.*`、`screen.*`、viewport 或元素矩形。

删除 `_safe_startup_window_size()` 的隐藏减 `80` 行为。`set_window_size_on_opts`
默认保留 `False`；显式 `True` 时才走外窗设置路径，不是默认推荐。

这是智能指纹默认行为的兼容性变更。README、指纹子文档和智能指纹示例必须同步
说明：`set_window_size_on_opts` 仅为兼容保留且已忽略。需要启动外框的调用方，
应直接调用 `FirefoxOptions.set_window_size()`。

用户直接调用 `FirefoxOptions.set_window_size()`、`page.set_window_size()`、`page.set_viewport()` 或 `page.emulation.set_screen_size()` 时，仍尊重其显式意图。

## Runtime Geometry

`FirefoxBase.set_window_size()` 只调整外部窗口，不同步修改 viewport、DPR 或
screen。`FirefoxPage._apply_startup_window_size()` 只处理用户通过
`FirefoxOptions.set_window_size()` 显式产生的 `startup_window_size`；
智能指纹默认不再产生该值。显式窗口设置路径可以恢复 normal 状态并调整外框，
因为这是调用方主动请求，不属于隐式指纹补偿。

若实机几何不符合 16/93，应报告窗口状态、DPI、工具栏或 Firefox 构建差异，而不是对页面坐标做补偿。

## Drag Input

拖拽必须在一次 `input.performActions` 中保持：

1. 移动到起点。
2. `pointerDown(button=0)`。
3. 按住期间的 pause 和拟人移动。
4. `pointerUp(button=0)`。

浏览器回归除验证轨迹外，还验证：

- `pointerdown.buttons == 1`。
- 从按下到释放之间的所有 `pointermove.buttons == 1`。
- `pointerup.buttons == 0`。
- `gotpointercapture` 和 `lostpointercapture` 顺序正确。
- 指针离开拖拽手柄边界后仍能继续移动目标。
- 目标元素确实发生位移并达到预期终点。

## Tests

### Unit

- 1366×768 fpfile 删除 `width` / `height`。
- 默认智能指纹不调用 `set_window_size()`。
- 兼容开关不调用 `set_window_size()`，只记录弃用提示。
- 不再存在启动尺寸隐藏减值。
- `pointerDown` 到 `pointerUp` 合并为一次 BiDi 调用。
- 指纹默认行为变更对应的 README、指纹文档和示例已更新。

### Browser

- 目标 Firefox 指纹浏览器宽差为 16、高差为 93。
- ruyiPage 不改写 `screen.*` 或 viewport。
- `getBoundingClientRect()` 坐标可直接命中元素。
- 拖动阶段全部 DOM `buttons` 状态连续，pointer capture 完整，且目标发生位移。
- 新增 TikTok 风格的自定义 pointer 拖拽 fixture，不依赖 iframe 或 HTML5 `dataTransfer`。

## Compatibility

- 窗口、viewport 和 emulation 公共 API 不变。
- 默认智能指纹不再隐式 resize，这是本次行为修正。
- `set_window_size_on_opts` 仅为兼容保留且已忽略，不做任何外框补偿。
- 默认值变化必须在发版说明、README 和示例中明确标记。

## Non-Goals

- 不为其他 Firefox 主题、系统或 DPI 强制制造 16/93。
- 不自动纠正第三方程序强制最大化的窗口。
- 不修改 Firefox 指纹浏览器内核。
- 不新增生产环境固定 16/93 校验或自动修复 API；该约束由目标浏览器回归测试验证。

## Success Criteria

- 默认智能指纹启动不包含隐式窗口修改。
- Firefox 原生计算 inner/outer 几何。
- 页面坐标无固定差值补偿。
- 拖拽按压状态在单次 BiDi 调用中连续。
- 快速测试通过，目标指纹浏览器实机满足 16/93 并能正确点击和拖拽。
