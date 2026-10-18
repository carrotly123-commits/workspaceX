# -*- coding: utf-8 -*-
"""示例35: 原生 BiDi 拖拽（严格结果版）"""

import io
import os
import sys
from pathlib import Path
from typing import Dict, List


BASE_DIR = Path(__file__).resolve().parent


if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


from ruyipage import FirefoxOptions, FirefoxPage


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
    print("测试 35: 原生 BiDi 拖拽")
    print("=" * 70)

    opts = FirefoxOptions()
    opts.headless(False)
    page = FirefoxPage(opts)
    results: List[Dict[str, str]] = []

    try:
        test_page = BASE_DIR / "test_pages" / "native_bidi_drag_test.html"
        test_url = test_page.resolve().as_uri()
        page.get(test_url)
        page.wait(0.8)
        add_result(results, "测试页加载", "成功", test_url)

        source = page.ele("#drag-source")
        target = page.ele("#drop-target")
        if not source or not target:
            add_result(results, "拖拽元素定位", "失败", "未找到 source 或 target 元素")
            print_results(results)
            return

        # 只使用高层原生 BiDi 拖拽能力，不直接暴露 _bidi.input_。
        page.actions.drag(source, target, duration=640, steps=16).perform()
        page.actions.release()
        page.wait(0.8)

        state = page.run_js("return window.nativeBidiDragState") or {}
        result_text = page.ele("#result").text

        if result_text == "拖拽成功":
            add_result(results, "拖拽结果文本", "成功", result_text)
        else:
            add_result(results, "拖拽结果文本", "失败", result_text or "")

        if state.get("dropped") is True:
            add_result(results, "HTML5 drop 命中", "成功", "dropped=True")
        else:
            add_result(results, "HTML5 drop 命中", "失败", f"state={state}")

        if state.get("enteredTarget") is True:
            add_result(results, "目标区域进入", "成功", "enteredTarget=True")
        else:
            add_result(results, "目标区域进入", "失败", f"state={state}")

        if (
            state.get("trustedMouseDown") is True
            and state.get("trustedMouseUp") is True
        ):
            add_result(
                results,
                "isTrusted mouse down/up",
                "成功",
                "mouseDown/mouseUp 均为 trusted",
            )
        else:
            add_result(
                results,
                "isTrusted mouse down/up",
                "失败",
                f"down={state.get('trustedMouseDown')} up={state.get('trustedMouseUp')}",
            )

        move_count = int(state.get("trustedMoveCount") or 0)
        if move_count > 0:
            add_result(
                results,
                "isTrusted move count",
                "成功",
                f"trustedMoveCount={move_count}",
            )
        else:
            add_result(
                results,
                "isTrusted move count",
                "失败",
                f"trustedMoveCount={move_count}",
            )

        last_x = state.get("lastClientX")
        last_y = state.get("lastClientY")
        if last_x is not None and last_y is not None:
            add_result(results, "最后指针坐标", "成功", f"({last_x}, {last_y})")
        else:
            add_result(results, "最后指针坐标", "跳过", "页面未记录最后指针坐标")

        print_results(results)

    except Exception as e:
        add_result(results, "示例执行", "失败", str(e)[:160])
        print_results(results)
        raise
    finally:
        try:
            page.actions.release()
        except Exception:
            pass
        try:
            page.quit()
        except Exception:
            pass


if __name__ == "__main__":
    main()
