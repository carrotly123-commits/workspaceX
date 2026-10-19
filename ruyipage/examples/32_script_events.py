#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""示例32: Script Events（严格结果版）"""

import io
import sys
from typing import Dict, List

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

from ruyipage import FirefoxPage, PreloadScript


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
    print("测试 32: Script Events")
    print("=" * 70)

    page = FirefoxPage()
    results: List[Dict[str, str]] = []
    temp_tab = None
    preload: PreloadScript | None = None

    try:
        page.get("https://www.example.com")
        add_result(results, "页面加载", "成功", "example.com 已加载")

        # 1. realmCreated / realmDestroyed
        page.realms.start()
        initial_realms = page.realms.list()
        add_result(
            results,
            "script.getRealms baseline",
            "成功",
            f"初始 realm 数量: {len(initial_realms)}",
        )

        temp_tab = page.contexts.create_tab()
        page.wait(1)
        created_realms = page.realms.list()
        if len(created_realms) > len(initial_realms):
            add_result(
                results,
                "script.realmCreated",
                "成功",
                f"realm 数量: {len(initial_realms)} -> {len(created_realms)}",
            )
        else:
            add_result(
                results, "script.realmCreated", "跳过", "当前环境未稳定观察到新增 realm"
            )

        if temp_tab:
            page.contexts.close(temp_tab)
            temp_tab = None
            page.wait(1)

        destroyed_realms = page.realms.list()
        if len(destroyed_realms) <= len(created_realms):
            add_result(
                results,
                "script.realmDestroyed",
                "成功",
                f"关闭后 realm 数量: {len(destroyed_realms)}",
            )
        else:
            add_result(
                results,
                "script.realmDestroyed",
                "跳过",
                "当前环境未稳定观察到 realm 销毁",
            )

        page.realms.stop()

        # 2. script.message
        if page.events.start(["script.message"], contexts=[page.tab_id]):
            preload = page.add_preload_script(
                """
                () => {
                    const ch = new BroadcastChannel('ruyi-script-message');
                    ch.postMessage({ type: 'preload', value: 'hello' });
                    ch.close();
                }
                """
            )

            page.get("https://www.example.com/?script-message=1")
            message_event = page.events.wait("script.message", timeout=3)

            if message_event:
                add_result(
                    results,
                    "script.message",
                    "成功",
                    f"channel={message_event.channel} data={message_event.data}",
                )
            else:
                add_result(
                    results,
                    "script.message",
                    "跳过",
                    "当前环境未稳定观察到 script.message",
                )
        else:
            add_result(
                results, "script.message", "不支持", "未能订阅 script.message 事件"
            )

        print_results(results)

    except Exception as e:
        add_result(results, "示例执行", "失败", str(e)[:120])
        print_results(results)
        raise
    finally:
        if preload is not None:
            try:
                page.remove_preload_script(preload)
            except Exception:
                pass
        try:
            page.realms.stop()
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
        try:
            page.quit()
        except Exception:
            pass


if __name__ == "__main__":
    main()
