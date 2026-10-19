#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""示例25: Browser 模块（用户上下文 + 客户端窗口）严格结果版"""

import io
import sys
import time
from typing import Dict, List

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

from ruyipage import FirefoxPage


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
    print("测试 25: Browser 用户上下文与窗口管理")
    print("=" * 70)

    page = FirefoxPage()
    results: List[Dict[str, str]] = []
    user_context_id = None
    new_tab_ctx = None

    try:
        page.get("https://www.example.com")

        # 1. user context 生命周期
        before = page.browser_tools.get_user_contexts()
        before_ids = [i.get("userContext") for i in before]
        add_result(
            results,
            "browser.getUserContexts before",
            "成功",
            f"创建前数量: {len(before)}",
        )

        user_context_id = page.browser_tools.create_user_context()
        if user_context_id:
            add_result(
                results,
                "browser.createUserContext",
                "成功",
                f"userContext={user_context_id}",
            )
        else:
            add_result(
                results, "browser.createUserContext", "失败", "未返回 userContext ID"
            )

        after_create = page.browser_tools.get_user_contexts()
        after_create_ids = [i.get("userContext") for i in after_create]
        if user_context_id in after_create_ids and len(after_create) == len(before) + 1:
            add_result(
                results,
                "browser.getUserContexts after create",
                "成功",
                f"数量变为 {len(after_create)}",
            )
        else:
            add_result(
                results,
                "browser.getUserContexts after create",
                "失败",
                "创建后数量或ID校验不通过",
            )

        if user_context_id:
            new_tab_ctx = page.browser_tools.create_tab(user_context=user_context_id)
            if new_tab_ctx:
                add_result(
                    results,
                    "browsingContext.create tab in user context",
                    "成功",
                    f"context={new_tab_ctx}",
                )
            else:
                add_result(
                    results,
                    "browsingContext.create tab in user context",
                    "失败",
                    "未返回新 tab context",
                )

        if new_tab_ctx:
            try:
                page.contexts.close(new_tab_ctx)
                add_result(
                    results, "browsingContext.close new tab", "成功", "新 tab 已关闭"
                )
                new_tab_ctx = None
            except Exception as e:
                add_result(
                    results, "browsingContext.close new tab", "跳过", str(e)[:120]
                )

        if user_context_id:
            page.browser_tools.remove_user_context(user_context_id)
            add_result(
                results,
                "browser.removeUserContext",
                "成功",
                f"已删除 {user_context_id}",
            )

            after_remove = page.browser_tools.get_user_contexts()
            after_remove_ids = [i.get("userContext") for i in after_remove]
            if user_context_id not in after_remove_ids and len(after_remove) == len(
                before_ids
            ):
                add_result(
                    results,
                    "browser.getUserContexts after remove",
                    "成功",
                    f"数量回到 {len(after_remove)}",
                )
            else:
                add_result(
                    results,
                    "browser.getUserContexts after remove",
                    "失败",
                    "删除后数量或ID校验不通过",
                )
            user_context_id = None

        # 2. client window 状态流
        windows = page.browser_tools.get_client_windows()
        if not windows:
            add_result(
                results, "browser.getClientWindows", "失败", "未返回任何 client window"
            )
        else:
            add_result(
                results, "browser.getClientWindows", "成功", f"窗口数量: {len(windows)}"
            )
            win = windows[0]
            win_id = win.get("clientWindow")
            states = ["minimized", "normal", "maximized", "fullscreen", "normal"]
            state_notes = []
            state_failed = False
            for state in states:
                page.browser_tools.set_window_state(win_id, state=state)
                time.sleep(0.4)
                current_windows = page.browser_tools.get_client_windows()
                current = current_windows[0] if current_windows else {}
                current_state = current.get("state")
                state_notes.append(f"{state}->{current_state}")
                if current_state != state:
                    state_failed = True

            if state_failed:
                add_result(
                    results,
                    "browser.setClientWindowState",
                    "失败",
                    ", ".join(state_notes),
                )
            else:
                add_result(
                    results,
                    "browser.setClientWindowState",
                    "成功",
                    ", ".join(state_notes),
                )

        print_results(results)

    except Exception as e:
        add_result(results, "示例执行", "失败", str(e)[:120])
        print_results(results)
        raise
    finally:
        if new_tab_ctx:
            try:
                page.contexts.close(new_tab_ctx)
            except Exception:
                pass
        if user_context_id:
            try:
                page.browser_tools.remove_user_context(user_context_id)
            except Exception:
                pass
        try:
            page.quit()
        except Exception:
            pass


if __name__ == "__main__":
    main()
