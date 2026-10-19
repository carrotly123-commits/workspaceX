# -*- coding: utf-8 -*-
"""Example 47: Debug Trace 与 Failure Snapshot 诊断演示

专门演示 ruyipage 的调试诊断与观测功能：

1. 三种启用 Trace 的方式（launch / FirefoxOptions / Settings）
2. Trace 时间线 API — summary(), dump_json(), latest(), recent_requests()
3. Trace 缓冲区管理 — clear(), enabled, repr
4. Failure Snapshot — 操作失败时自动抓取截图/DOM/URL/trace/网络
5. FailureSnapshot 数据 API — summary(), to_json(), to_dict()
6. 异常的 .diagnostics 属性 — 从 except 块直接访问诊断信息
7. 敏感字段自动脱敏 — password / cookie / authorization 等

注意：Trace 功能默认关闭，不影响正常使用性能。
"""

import io
import json
import sys
import time

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

from ruyipage import (
    launch,
    FirefoxOptions,
    FirefoxPage,
    Settings,
    TraceEntry,
    FailureSnapshot,
)
from ruyipage.errors import ElementNotFoundError, JavaScriptError, WaitTimeoutError

from test_server import TestServer


def sep(title):
    print("\n" + "=" * 60)
    print(f"  {title}")
    print("=" * 60)


# =====================================================================
# Part 1: 三种启用方式
# =====================================================================

def demo_enable_methods():
    sep("Part 1: 三种启用 Trace 的方式")

    # --- 方式 A: launch() 参数（最简单） ---
    print("\n--- 方式 A: launch(trace=True) ---")
    print("  page = launch(trace=True)")
    print("  # 即可开始记录所有 BiDi 命令和事件")

    # --- 方式 B: FirefoxOptions 链式调用 ---
    print("\n--- 方式 B: FirefoxOptions ---")
    print("  opts = FirefoxOptions()")
    print("  opts.enable_trace(True)           # 启用 trace")
    print("  opts.enable_failure_snapshot()     # 启用失败快照")
    print("  opts.set_snapshot_dir('./diag')    # 快照保存目录")
    print("  page = FirefoxPage(opts)")

    # --- 方式 C: Settings 全局开关 ---
    print("\n--- 方式 C: Settings 全局开关 ---")
    print("  Settings.trace_enabled = True      # 全局开启")
    print("  Settings.trace_max_entries = 2000  # 调整缓冲区大小")
    print("  Settings.failure_snapshot_enabled = True")


# =====================================================================
# Part 2: Trace 时间线 API 全演示
# =====================================================================

def demo_trace_api(page, server):
    sep("Part 2: Trace 时间线 API")
    base = server.get_url

    # 2.1 做一些操作，让 trace 缓冲区积累数据
    print("\n[2.1] 执行操作，积累 trace 数据...")
    page.get(base("/nav/basic"))
    page.wait(0.5)
    page.get(base("/nav/history"))
    page.wait(0.5)
    page.run_js("document.title")
    page.ele("tag:h1")

    # 2.2 trace.enabled — 查看当前是否启用
    print(f"\n[2.2] page.trace.enabled = {page.trace.enabled}")

    # 2.3 trace.latest(n) — 获取最近 N 条 TraceEntry
    print("\n[2.3] page.trace.latest(5) — 最近 5 条记录:")
    entries = page.trace.latest(5)
    for e in entries:
        print(f"  {e}")
    print(f"  (共 {len(entries)} 条)")

    # 2.4 TraceEntry 属性
    if entries:
        e = entries[-1]
        print(f"\n[2.4] TraceEntry 详细属性:")
        print(f"  category   = {e.category}")
        print(f"  event      = {e.event}")
        print(f"  status     = {e.status}")
        print(f"  elapsed_ms = {e.elapsed_ms}")
        print(f"  context_id = {e.context_id}")
        print(f"  data       = {e.data}")

        # 2.4.1 to_dict()
        d = e.to_dict()
        print(f"\n  TraceEntry.to_dict() 输出:")
        print(f"    {json.dumps(d, ensure_ascii=False)}")

    # 2.5 trace.summary() — 人类可读摘要
    print(f"\n[2.5] page.trace.summary(10):\n")
    print(page.trace.summary(10))

    # 2.6 trace.dump_json() — 全量 JSON 导出
    print(f"\n[2.6] page.trace.dump_json() — 前 500 字符:")
    j = page.trace.dump_json()
    print(j[:500])
    if len(j) > 500:
        print(f"  ...(总共 {len(j)} 字符)")

    # 2.7 repr
    print(f"\n[2.7] repr(page.trace) = {repr(page.trace)}")


# =====================================================================
# Part 3: 网络请求记录
# =====================================================================

def demo_network_trace(page, server):
    sep("Part 3: 网络请求记录 (trace.recent_requests)")
    base = server.get_url

    # 先订阅网络事件，trace 的 recv_loop 被动钩子才能捕获
    page.listen.start()

    page.get(base("/nav/basic"))
    page.wait(0.5)

    # 用 JS 发起一些请求
    page.run_js(f"""
        fetch('{base("/api/data")}');
        fetch('{base("/api/headers")}');
    """)
    page.wait(1)

    # 查看网络请求记录
    reqs = page.trace.recent_requests(10)
    print(f"\n最近 {len(reqs)} 条网络请求:")
    for r in reqs:
        print(f"  [{r.get('method', '?'):>4}] {r.get('status', '?'):>3}  "
              f"{r.get('url', '?')[:80]}")

    page.listen.stop()


# =====================================================================
# Part 4: Trace 缓冲区管理
# =====================================================================

def demo_trace_management(page):
    sep("Part 4: 缓冲区管理")

    count_before = len(page.trace.latest(9999))
    print(f"\n[4.1] 清空前: {count_before} 条记录")

    page.trace.clear()

    count_after = len(page.trace.latest(9999))
    print(f"[4.2] 清空后: {count_after} 条记录")

    # 执行新操作
    page.run_js("1 + 1")
    page.run_js("document.title")

    count_new = len(page.trace.latest(9999))
    print(f"[4.3] 新操作后: {count_new} 条记录")

    # summary 方法在空缓冲区时的行为
    page.trace.clear()
    print(f"\n[4.4] 空缓冲区 summary: '{page.trace.summary()}'")


# =====================================================================
# Part 5: Failure Snapshot — 失败自动诊断
# =====================================================================

def demo_failure_snapshot(page, server):
    sep("Part 5: Failure Snapshot — 失败自动诊断")
    base = server.get_url

    page.get(base("/nav/basic"))
    page.wait(0.5)

    # 5.1 ElementNotFoundError — 查找不存在的元素
    # ele() 默认不抛异常（返回 NoneElement），需临时开启 raise 模式
    print("\n[5.1] 触发 ElementNotFoundError:")
    print("  Settings.raise_when_ele_not_found = True")
    print("  page.ele('#this-element-does-not-exist', timeout=2)")
    orig_raise = Settings.raise_when_ele_not_found
    Settings.raise_when_ele_not_found = True
    try:
        page.ele("#this-element-does-not-exist", timeout=2)
    except ElementNotFoundError as e:
        print(f"  捕获异常: {type(e).__name__}: {e}")

        if e.diagnostics:
            snap = e.diagnostics
            print(f"\n  异常的 .diagnostics 属性 (FailureSnapshot):")
            print(f"    error_type     = {snap.error_type}")
            print(f"    error_message  = {snap.error_message[:80]}")
            print(f"    url            = {snap.url}")
            print(f"    context_id     = {snap.context_id}")
            print(f"    screenshot     = {snap.screenshot_path or '(未保存到文件)'}")
            print(f"    dom_path       = {snap.dom_path or '(未保存到文件)'}")
            print(f"    trace_entries  = {len(snap.trace_entries)} 条")
            print(f"    recent_reqs    = {len(snap.recent_requests)} 条")
            print(f"    capture_errors = {snap.capture_errors}")

            # 5.1.1 summary()
            print(f"\n  FailureSnapshot.summary():\n")
            print(snap.summary())

            # 5.1.2 to_json()
            print(f"\n  FailureSnapshot.to_json() — 前 400 字符:")
            j = snap.to_json()
            print(j[:400])
            if len(j) > 400:
                print(f"  ...(总共 {len(j)} 字符)")

            # 5.1.3 to_dict()
            d = snap.to_dict()
            print(f"\n  to_dict() 的 keys: {list(d.keys())}")

        else:
            print("  (diagnostics 为 None — 未启用 failure_snapshot)")
    finally:
        Settings.raise_when_ele_not_found = orig_raise

    # 5.2 JavaScriptError — 执行错误的 JS
    print("\n\n[5.2] 触发 JavaScriptError:")
    print("  page.run_js('throw new Error(\"demo error\")')")
    try:
        page.run_js('throw new Error("demo error for diagnostic")')
    except JavaScriptError as e:
        print(f"  捕获异常: {type(e).__name__}: {e}")
        if e.diagnostics:
            print(f"  diagnostics.error_type = {e.diagnostics.error_type}")
            print(f"  diagnostics.url        = {e.diagnostics.url}")
            print(f"\n  FailureSnapshot.summary():\n")
            print(e.diagnostics.summary())
        else:
            print("  (diagnostics 为 None — 未启用 failure_snapshot)")

    # 5.3 WaitTimeoutError — 等待元素超时
    # wait 系列方法默认不抛异常（返回 False），需临时开启 raise 模式
    # 注: waiter 工具类不包含 snapshot 集成（无需浏览器级诊断），
    #     diagnostics 在 wait_loading / _find_element / run_js / get 等页面级方法中自动附加。
    print("\n\n[5.3] 触发 WaitTimeoutError:")
    print("  Settings.raise_when_wait_failed = True")
    print("  page.wait.ele_displayed('#never-exists', timeout=2)")
    orig_wait_raise = Settings.raise_when_wait_failed
    Settings.raise_when_wait_failed = True
    try:
        page.wait.ele_displayed("#never-exists", timeout=2)
    except WaitTimeoutError as e:
        print(f"  捕获异常: {type(e).__name__}: {e}")
        print(f"  diagnostics = {e.diagnostics}")
        print("  (waiter 工具类级别的超时，不包含 snapshot)")
        print("  snapshot 自动附加场景: ele(raise_err=True) / run_js / get / wait_loading")
    finally:
        Settings.raise_when_wait_failed = orig_wait_raise


# =====================================================================
# Part 6: FailureSnapshot 数据结构独立演示
# =====================================================================

def demo_snapshot_standalone():
    sep("Part 6: FailureSnapshot 数据结构")

    snap = FailureSnapshot()
    snap.error_type = "ElementNotFoundError"
    snap.error_message = "未找到元素: #submit-btn"
    snap.url = "https://example.com/checkout"
    snap.context_id = "ctx-abc-123"
    snap.screenshot_path = "./diag/1714531200_screenshot.png"
    snap.dom_path = "./diag/1714531200_dom.html"
    snap.saved_dir = "./diag"
    snap.recent_requests = [
        {"url": "https://api.example.com/cart", "method": "GET", "status": 200},
        {"url": "https://api.example.com/pay", "method": "POST", "status": 500},
    ]
    snap.trace_entries = [
        TraceEntry("bidi_cmd", "browsingContext.navigate",
                   {"url": "https://example.com"}, elapsed_ms=320),
        TraceEntry("bidi_cmd", "script.evaluate",
                   {"expression": "document.title"}, elapsed_ms=5),
        TraceEntry("error", "element_not_found",
                   {"locator": "#submit-btn"}, status="error"),
    ]

    # summary
    print("\n[6.1] FailureSnapshot.summary():\n")
    print(snap.summary())

    # to_json
    print("\n[6.2] FailureSnapshot.to_json():\n")
    print(snap.to_json())

    # repr
    print(f"\n[6.3] repr(snap) = {repr(snap)}")


# =====================================================================
# Part 7: TraceEntry 数据结构独立演示
# =====================================================================

def demo_trace_entry_standalone():
    sep("Part 7: TraceEntry 数据结构")

    # 创建
    entry = TraceEntry(
        category="bidi_cmd",
        event="browsingContext.navigate",
        data={"url": "https://example.com", "wait": "complete"},
        context_id="ctx-abc-123",
        elapsed_ms=280.567,
        status="ok",
    )

    print(f"\n[7.1] 属性:")
    print(f"  category   = {entry.category}")
    print(f"  event      = {entry.event}")
    print(f"  data       = {entry.data}")
    print(f"  context_id = {entry.context_id}")
    print(f"  elapsed_ms = {entry.elapsed_ms}  (自动四舍五入到 2 位小数)")
    print(f"  status     = {entry.status}")
    print(f"  timestamp  = {entry.timestamp}")

    print(f"\n[7.2] to_dict():")
    print(f"  {json.dumps(entry.to_dict(), ensure_ascii=False)}")

    print(f"\n[7.3] repr():")
    print(f"  {repr(entry)}")


# =====================================================================
# Part 8: 敏感字段自动脱敏
# =====================================================================

def demo_scrub():
    sep("Part 8: 敏感字段自动脱敏")

    from ruyipage._units.tracer import _scrub_dict

    # 8.1 敏感字段
    raw = {
        "username": "admin",
        "password": "super_secret_123",
        "Cookie": "session=abc123xyz",
        "authorization": "Bearer eyJhbGciOi...",
        "url": "https://example.com/login",
        "data": "普通内容",
    }
    scrubbed = _scrub_dict(raw)
    print("\n[8.1] 敏感字段脱敏:")
    print(f"  输入: {json.dumps(raw, ensure_ascii=False)}")
    print(f"  输出: {json.dumps(scrubbed, ensure_ascii=False)}")
    print("  → password / Cookie / authorization 被替换为 '***'")

    # 8.2 超长字符串截断
    raw2 = {"script": "x" * 600}
    scrubbed2 = _scrub_dict(raw2, max_str_len=100)
    print(f"\n[8.2] 超长字符串截断 (600字符 → max_str_len=100):")
    print(f"  输出: {json.dumps(scrubbed2, ensure_ascii=False)[:120]}...")

    # 8.3 嵌套 dict
    raw3 = {
        "headers": {
            "Authorization": "Basic dXNlcjpwYXNz",
            "Content-Type": "application/json",
        }
    }
    scrubbed3 = _scrub_dict(raw3)
    print(f"\n[8.3] 嵌套脱敏:")
    print(f"  输入: {json.dumps(raw3, ensure_ascii=False)}")
    print(f"  输出: {json.dumps(scrubbed3, ensure_ascii=False)}")

    # 8.4 列表截断（最多 10 项）
    raw4 = {"items": [{"id": i} for i in range(20)]}
    scrubbed4 = _scrub_dict(raw4)
    print(f"\n[8.4] 列表截断 (20项 → 10项):")
    print(f"  输入长度: {len(raw4['items'])}")
    print(f"  输出长度: {len(scrubbed4['items'])}")


# =====================================================================
# Part 9: Settings 配置项一览
# =====================================================================

def demo_settings():
    sep("Part 9: Settings 诊断相关配置项")

    print(f"""
  Settings.trace_enabled            = {Settings.trace_enabled}
    → 是否启用 trace 记录（默认 False）

  Settings.trace_max_entries         = {Settings.trace_max_entries}
    → trace 缓冲区最大条目数（默认 1000）

  Settings.failure_snapshot_enabled  = {Settings.failure_snapshot_enabled}
    → 是否启用失败自动诊断快照（默认 False）

  Settings.snapshot_dom_max_bytes    = {Settings.snapshot_dom_max_bytes}
    → DOM 快照最大字节数（默认 2MB）

  Settings.snapshot_recent_requests  = {Settings.snapshot_recent_requests}
    → 快照中包含的最近网络请求数量（默认 30）
""")


# =====================================================================
# Part 10: FirefoxOptions 链式 API 演示
# =====================================================================

def demo_firefox_options():
    sep("Part 10: FirefoxOptions 诊断相关 API")

    opts = FirefoxOptions()

    # 链式调用
    opts.enable_trace(True)
    print(f"  opts.enable_trace(True)")
    print(f"    → opts.trace_enabled = {opts.trace_enabled}")

    opts.enable_failure_snapshot()
    print(f"  opts.enable_failure_snapshot()")
    print(f"    → opts.failure_snapshot_enabled = {opts.failure_snapshot_enabled}")

    opts.set_snapshot_dir("./my_diagnostics")
    print(f"  opts.set_snapshot_dir('./my_diagnostics')")
    print(f"    → opts.snapshot_dir = {opts.snapshot_dir}")

    # quick_start
    print(f"\n  quick_start 一键配置:")
    opts2 = FirefoxOptions()
    opts2.quick_start(trace=True, failure_snapshot=True, snapshot_dir="./diag")
    print(f"    opts.quick_start(trace=True, failure_snapshot=True, snapshot_dir='./diag')")
    print(f"    → trace_enabled          = {opts2.trace_enabled}")
    print(f"    → failure_snapshot_enabled = {opts2.failure_snapshot_enabled}")
    print(f"    → snapshot_dir           = {opts2.snapshot_dir}")


# =====================================================================
# main
# =====================================================================

def main():
    print("=" * 60)
    print("  Example 47: Debug Trace 与 Failure Snapshot 诊断演示")
    print("=" * 60)

    # --- 纯数据结构演示（不需要浏览器） ---
    demo_enable_methods()
    demo_trace_entry_standalone()
    demo_snapshot_standalone()
    demo_scrub()
    demo_settings()
    demo_firefox_options()

    # --- 需要浏览器的实战演示 ---
    server = TestServer(port=8891).start()

    # 通过 launch() 一行开启所有诊断功能
    page = launch(
        trace=True,
        failure_snapshot=True,
        snapshot_dir="./diag_output_47",
    )

    try:
        demo_trace_api(page, server)
        demo_network_trace(page, server)
        demo_trace_management(page)
        demo_failure_snapshot(page, server)

        sep("全部演示完成")
        print("""
  本例演示了 ruyipage 诊断观测系统的全部 API:

  启用方式:
    - launch(trace=True, failure_snapshot=True)
    - FirefoxOptions().enable_trace() / .enable_failure_snapshot()
    - Settings.trace_enabled = True

  Trace 时间线:
    - page.trace.enabled         → 是否启用
    - page.trace.latest(n)       → 最近 N 条 TraceEntry
    - page.trace.recent_requests(n) → 最近 N 条网络请求
    - page.trace.summary(n)      → 人类可读摘要
    - page.trace.dump_json()     → 完整 JSON 导出
    - page.trace.clear()         → 清空缓冲区

  TraceEntry:
    - .category / .event / .data / .context_id / .elapsed_ms / .status
    - .to_dict()

  FailureSnapshot:
    - .error_type / .error_message / .url / .context_id
    - .screenshot_path / .dom_path / .saved_dir
    - .recent_requests / .trace_entries / .capture_errors
    - .summary() / .to_json() / .to_dict()

  异常诊断:
    - except SomeError as e: e.diagnostics → FailureSnapshot | None

  敏感脱敏:
    - password / cookie / authorization 等字段自动替换为 ***
    - 超长字符串自动截断
""")
    finally:
        page.quit()
        server.stop()


if __name__ == "__main__":
    main()
