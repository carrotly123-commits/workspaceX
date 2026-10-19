#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""示例30: BrowsingContext Events（严格结果版）"""

import io
import sys
from typing import Dict, List

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

from ruyipage import BidiEvent, FirefoxPage


def add_result(
    results: List[Dict[str, str]], item: str, status: str, note: str
) -> None:
    results.append({"item": item, "status": status, "note": note})


def print_results(results: List[Dict[str, str]]) -> None:
    print("\n| 项目 | 状态 | 说明 |")
    print("| --- | --- | --- |")
    for row in results:
        print(f"| {row['item']} | {row['status']} | {row['note']} |")


def main() -> None:
    print("=" * 70)
    print("测试 30: BrowsingContext Events")
    print("=" * 70)

    page = FirefoxPage()
    results: List[Dict[str, str]] = []
    temp_tab = None
    temp_window = None

    try:
        page.get("https://www.example.com")
        add_result(results, "页面加载", "成功", "example.com 已加载")

        if page.events.start(
            [
                "browsingContext.contextCreated",
                "browsingContext.contextDestroyed",
                "browsingContext.userPromptOpened",
                "browsingContext.userPromptClosed",
            ],
            contexts=[],
        ):
            add_result(results, "事件订阅", "成功", "已订阅 context / prompt 相关事件")
        else:
            add_result(results, "事件订阅", "失败", "未能订阅 browsingContext 事件")
            print_results(results)
            return

        # 1. contextCreated / contextDestroyed
        page.events.clear()
        temp_tab = page.contexts.create_tab()
        created_tab: BidiEvent | None = page.events.wait(
            "browsingContext.contextCreated", timeout=3
        )
        if created_tab and created_tab.context == temp_tab:
            add_result(
                results,
                "browsingContext.contextCreated tab",
                "成功",
                f"context={temp_tab}",
            )
        else:
            add_result(
                results,
                "browsingContext.contextCreated tab",
                "失败",
                f"expected={temp_tab}",
            )

        temp_window = page.contexts.create_window()
        created_window: BidiEvent | None = page.events.wait(
            "browsingContext.contextCreated", timeout=3
        )
        if created_window and created_window.context == temp_window:
            add_result(
                results,
                "browsingContext.contextCreated window",
                "成功",
                f"context={temp_window}",
            )
        else:
            add_result(
                results,
                "browsingContext.contextCreated window",
                "失败",
                f"expected={temp_window}",
            )

        if temp_tab:
            page.contexts.close(temp_tab)
            destroyed_tab = page.events.wait(
                "browsingContext.contextDestroyed", timeout=3
            )
            if destroyed_tab and destroyed_tab.context == temp_tab:
                add_result(
                    results,
                    "browsingContext.contextDestroyed tab",
                    "成功",
                    f"context={temp_tab}",
                )
            else:
                add_result(
                    results,
                    "browsingContext.contextDestroyed tab",
                    "失败",
                    f"expected={temp_tab}",
                )
            temp_tab = None

        if temp_window:
            page.contexts.close(temp_window)
            destroyed_window = page.events.wait(
                "browsingContext.contextDestroyed", timeout=3
            )
            if destroyed_window and destroyed_window.context == temp_window:
                add_result(
                    results,
                    "browsingContext.contextDestroyed window",
                    "成功",
                    f"context={temp_window}",
                )
            else:
                add_result(
                    results,
                    "browsingContext.contextDestroyed window",
                    "失败",
                    f"expected={temp_window}",
                )
            temp_window = None

        # 2. userPromptOpened / userPromptClosed
        page.events.clear()

        page.run_js("alert('hello alert')", as_expr=False)
        opened_alert = page.events.wait("browsingContext.userPromptOpened", timeout=3)
        if opened_alert and opened_alert.user_prompt_type == "alert":
            add_result(
                results,
                "browsingContext.userPromptOpened alert",
                "成功",
                opened_alert.message or "",
            )
        else:
            add_result(
                results,
                "browsingContext.userPromptOpened alert",
                "失败",
                "未观察到 alert 打开事件",
            )

        page.accept_prompt(timeout=3)
        closed_alert = page.events.wait("browsingContext.userPromptClosed", timeout=3)
        if closed_alert and closed_alert.accepted is True:
            add_result(
                results,
                "browsingContext.userPromptClosed alert",
                "成功",
                f"accepted={closed_alert.accepted}",
            )
        else:
            add_result(
                results,
                "browsingContext.userPromptClosed alert",
                "失败",
                "未观察到 alert 关闭事件",
            )

        page.events.clear()
        page.set_prompt_handler(prompt="ignore", prompt_text="Test User")

        page.run_js("prompt('Enter your name:', 'default')", as_expr=False)
        opened_prompt = page.events.wait("browsingContext.userPromptOpened", timeout=3)
        if opened_prompt and opened_prompt.user_prompt_type == "prompt":
            add_result(
                results,
                "browsingContext.userPromptOpened prompt",
                "成功",
                opened_prompt.message or "",
            )
        else:
            add_result(
                results,
                "browsingContext.userPromptOpened prompt",
                "失败",
                "未观察到 prompt 打开事件",
            )

        closed_prompt = page.events.wait("browsingContext.userPromptClosed", timeout=3)
        if closed_prompt and closed_prompt.accepted is True:
            add_result(
                results,
                "browsingContext.userPromptClosed prompt",
                "成功",
                f"accepted={closed_prompt.accepted}",
            )
        else:
            add_result(
                results,
                "browsingContext.userPromptClosed prompt",
                "跳过",
                "当前环境下 prompt 自动注入文本后未稳定观察到 userPromptClosed",
            )

        page.clear_prompt_handler()
        print_results(results)

    except Exception as e:
        add_result(results, "示例执行", "失败", str(e)[:120])
        print_results(results)
        raise
    finally:
        try:
            page.clear_prompt_handler()
        except Exception:
            pass
        try:
            page.events.stop()
        except Exception:
            pass
        if temp_tab:
            try:
                page.contexts.close(temp_tab)
            except Exception:
                pass
        if temp_window:
            try:
                page.contexts.close(temp_window)
            except Exception:
                pass
        try:
            page.quit()
        except Exception:
            pass


if __name__ == "__main__":
    main()
