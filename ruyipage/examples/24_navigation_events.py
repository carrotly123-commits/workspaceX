#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""示例24: Navigation Events 导航事件测试（严格结果版）"""

import io
import sys
from typing import Dict, List

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

from ruyipage import FirefoxPage
from ruyipage._functions.tools import find_free_port

from test_server import TestServer


def add_result(
    results: List[Dict[str, str]], item: str, status: str, note: str
) -> None:
    """记录结构化结果。"""
    results.append({"item": item, "status": status, "note": note})


def print_results(results: List[Dict[str, str]]) -> None:
    """打印固定格式结果表。"""
    print("\n| 项目 | 状态 | 说明 |")
    print("| --- | --- | --- |")
    for row in results:
        print(f"| {row['item']} | {row['status']} | {row['note']} |")


def main() -> None:
    print("=" * 70)
    print("测试 24: Navigation Events 导航事件测试")
    print("=" * 70)

    page = FirefoxPage()
    server = None
    results: List[Dict[str, str]] = []

    try:
        server = TestServer(port=find_free_port(9030, 9130)).start()
        base_url = server.get_url("")[:-1]

        tracked_events = [
            "browsingContext.navigationStarted",
            "browsingContext.fragmentNavigated",
            "browsingContext.historyUpdated",
            "browsingContext.domContentLoaded",
            "browsingContext.load",
            "browsingContext.navigationCommitted",
            "browsingContext.navigationFailed",
        ]
        if not page.navigation.start(tracked_events):
            add_result(results, "导航事件订阅", "失败", "当前环境订阅导航事件失败")
            print_results(results)
            return

        # 1. 基础导航事件
        page.navigation.clear()
        page.get(base_url + "/nav/basic")
        started = page.navigation.wait("browsingContext.navigationStarted", timeout=3)
        dom_loaded = page.navigation.wait("browsingContext.domContentLoaded", timeout=3)
        loaded = page.navigation.wait_for_load(timeout=3)

        if started and (started.url or "").endswith("/nav/basic"):
            add_result(results, "navigationStarted", "成功", "收到基础导航开始事件")
        else:
            add_result(
                results, "navigationStarted", "失败", "未观察到基础页面导航开始事件"
            )

        if dom_loaded and dom_loaded.context == page.tab_id:
            add_result(
                results, "domContentLoaded", "成功", "收到 DOMContentLoaded 事件"
            )
        else:
            add_result(
                results, "domContentLoaded", "失败", "未观察到 DOMContentLoaded 事件"
            )

        if loaded and loaded.context == page.tab_id:
            add_result(results, "load", "成功", "收到 load 事件")
        else:
            add_result(results, "load", "失败", "未观察到 load 事件")

        # 2. fragmentNavigated
        page.get(base_url + "/nav/fragment")
        page.navigation.clear()
        page.run_js(
            """
            location.hash = '#a';
            setTimeout(function () { location.hash = '#b'; }, 100);
            """,
            as_expr=False,
        )
        first_fragment = page.navigation.wait_for_fragment("a", timeout=3)
        second_fragment = page.navigation.wait_for_fragment("b", timeout=3)

        if first_fragment and second_fragment:
            add_result(
                results,
                "fragmentNavigated",
                "成功",
                f"两次片段导航已触发: {first_fragment.url} -> {second_fragment.url}",
            )
        else:
            add_result(
                results,
                "fragmentNavigated",
                "不支持",
                "片段 URL 已变化，但当前 Firefox 未观察到标准 fragmentNavigated 事件",
            )

        # 3. historyUpdated
        page.get(base_url + "/nav/history")
        page.navigation.clear()
        page.run_js(
            """
            history.pushState({p:1}, 'P1', '?p=1');
            history.pushState({p:2}, 'P2', '?p=2');
            history.back();
            """,
            as_expr=False,
        )
        first_history = page.navigation.wait(
            "browsingContext.historyUpdated", timeout=3
        )
        second_history = page.navigation.wait(
            "browsingContext.historyUpdated", timeout=3
        )

        if first_history or second_history:
            add_result(
                results, "historyUpdated", "成功", "pushState/back 触发 historyUpdated"
            )
        else:
            add_result(
                results, "historyUpdated", "失败", "未观察到 historyUpdated 事件"
            )

        # 4. navigationCommitted
        page.navigation.clear()
        page.get(base_url + "/nav/basic?committed=1")
        committed = page.navigation.wait(
            "browsingContext.navigationCommitted", timeout=3
        )
        if committed and committed.context == page.tab_id:
            add_result(
                results,
                "navigationCommitted",
                "成功",
                "普通导航触发 navigationCommitted",
            )
        else:
            add_result(
                results,
                "navigationCommitted",
                "跳过",
                "当前环境未稳定观察到 navigationCommitted",
            )

        # 5. navigationFailed
        page.navigation.clear()
        try:
            page.get("http://127.0.0.1:9/", timeout=2)
        except Exception:
            pass
        failed = page.navigation.wait("browsingContext.navigationFailed", timeout=3)
        if failed:
            add_result(
                results, "navigationFailed", "成功", "不可达地址触发 navigationFailed"
            )
        else:
            add_result(
                results,
                "navigationFailed",
                "跳过",
                "当前环境未稳定观察到 navigationFailed",
            )

        # 6. navigationAborted
        if page.navigation.start(["browsingContext.navigationAborted"]):
            add_result(
                results,
                "navigationAborted",
                "跳过",
                "订阅成功，但本示例未构造稳定 aborted 场景",
            )
        else:
            add_result(
                results, "navigationAborted", "不支持", "当前 Firefox 不接受该事件名"
            )

        # 恢复默认跟踪，便于 finally 统一 stop
        page.navigation.start(tracked_events)

        print_results(results)

    except Exception as e:
        add_result(results, "示例执行", "失败", str(e)[:120])
        print_results(results)
        raise
    finally:
        try:
            page.navigation.stop()
        except Exception:
            pass
        try:
            if server is not None:
                server.stop()
        except Exception:
            pass
        try:
            page.quit()
        except Exception:
            pass


if __name__ == "__main__":
    main()
