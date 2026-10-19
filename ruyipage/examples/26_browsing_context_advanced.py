#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""示例26: BrowsingContext 高级功能（严格结果版）"""

import io
import sys
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
    print("测试 26: BrowsingContext 高级功能")
    print("=" * 70)

    page = FirefoxPage()
    child_id = None
    results: List[Dict[str, str]] = []

    try:
        page.get("https://www.example.com")
        add_result(results, "页面加载", "成功", "example.com 已加载")

        tree = page.contexts.get_tree()
        contexts = tree.contexts
        if contexts:
            add_result(
                results,
                "browsingContext.getTree",
                "成功",
                f"上下文数量: {len(contexts)}",
            )
        else:
            add_result(results, "browsingContext.getTree", "失败", "未返回任何上下文")

        child_id = page.contexts.create_tab()
        if child_id:
            add_result(
                results, "browsingContext.create", "成功", f"新 context: {child_id}"
            )
            page.contexts.close(child_id)
            add_result(results, "browsingContext.close", "成功", "新 context 已关闭")
            child_id = None
        else:
            add_result(results, "browsingContext.create", "失败", "未返回 context ID")

        r1 = page.contexts.reload()
        if r1.get("navigation"):
            add_result(
                results,
                "browsingContext.reload",
                "成功",
                f"navigation={r1.get('navigation')}",
            )
        else:
            add_result(
                results, "browsingContext.reload", "跳过", "当前返回未包含 navigation"
            )

        try:
            r2 = page.contexts.reload(ignore_cache=True)
            add_result(
                results,
                "browsingContext.reload ignoreCache",
                "成功",
                f"navigation={r2.get('navigation')}",
            )
        except Exception as e:
            add_result(
                results, "browsingContext.reload ignoreCache", "不支持", str(e)[:120]
            )

        try:
            page.contexts.set_bypass_csp(True)
            add_result(
                results, "browsingContext.setBypassCSP", "成功", "标准命令调用成功"
            )
        except Exception as e:
            add_result(results, "browsingContext.setBypassCSP", "不支持", str(e)[:120])

        page.contexts.set_viewport(800, 600)
        page.wait(0.2)
        vp = page.rect.viewport_size
        if tuple(vp) == (800, 600):
            add_result(
                results,
                "browsingContext.setViewport 800x600",
                "成功",
                f"实际视口: {vp}",
            )
        else:
            add_result(
                results,
                "browsingContext.setViewport 800x600",
                "失败",
                f"实际视口: {vp}",
            )

        page.contexts.set_viewport(375, 667)
        page.wait(0.2)
        vp2 = page.rect.viewport_size
        if tuple(vp2) == (375, 667):
            add_result(
                results,
                "browsingContext.setViewport 375x667",
                "成功",
                f"实际视口: {vp2}",
            )
        else:
            add_result(
                results,
                "browsingContext.setViewport 375x667",
                "失败",
                f"实际视口: {vp2}",
            )

        print_results(results)

    except Exception as e:
        add_result(results, "示例执行", "失败", str(e)[:120])
        print_results(results)
        raise
    finally:
        if child_id:
            try:
                page.contexts.close(child_id)
            except Exception:
                pass
        try:
            page.quit()
        except Exception:
            pass


if __name__ == "__main__":
    main()
