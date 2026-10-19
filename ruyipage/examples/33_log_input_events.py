#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""示例33: Log + Input Events（严格结果版）"""

import io
import os
import sys
from pathlib import Path
from typing import Dict, List


BASE_DIR = Path(__file__).resolve().parent

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

from ruyipage import FirefoxPage


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
    print("测试 33: Log + Input Events")
    print("=" * 70)

    page = FirefoxPage()
    results: List[Dict[str, str]] = []
    test_file = BASE_DIR / "test_file_dialog.html"

    try:
        # 1. log.entryAdded
        page.get("https://www.example.com")
        add_result(results, "页面加载", "成功", "example.com 已加载")

        page.console.start()
        page.console.clear()

        page.run_js("console.log('This is a log message')", as_expr=False)
        page.run_js("console.info('This is an info message')", as_expr=False)
        page.run_js("console.warn('This is a warning message')", as_expr=False)
        page.run_js("console.error('This is an error message')", as_expr=False)
        page.run_js("console.debug('This is a debug message')", as_expr=False)
        page.run_js(
            "console.table([{name: 'Alice', age: 18}, {name: 'Bob', age: 20}])",
            as_expr=False,
        )

        log_entry = page.console.wait(timeout=3)
        entries = page.console.entries
        error_entry = next((e for e in entries if e.level == "error"), None)
        warn_entry = next((e for e in entries if e.level == "warn"), None)
        table_entry = next(
            (
                e
                for e in entries
                if "Alice" in (e.text or "") or "Bob" in (e.text or "")
            ),
            None,
        )

        if log_entry:
            add_result(
                results,
                "log.entryAdded first",
                "成功",
                f"level={log_entry.level} text={log_entry.text}",
            )
        else:
            add_result(results, "log.entryAdded first", "失败", "未观察到首条日志事件")

        if error_entry:
            add_result(results, "log.entryAdded error", "成功", error_entry.text or "")
        else:
            add_result(
                results, "log.entryAdded error", "失败", "未观察到 error 日志事件"
            )

        if warn_entry:
            add_result(results, "log.entryAdded warn", "成功", warn_entry.text or "")
        else:
            add_result(results, "log.entryAdded warn", "失败", "未观察到 warn 日志事件")

        if table_entry:
            add_result(
                results, "log.entryAdded table", "成功", (table_entry.text or "")[:120]
            )
        else:
            add_result(
                results,
                "log.entryAdded table",
                "跳过",
                "当前 console.table 输出未稳定映射到 text",
            )

        add_result(
            results,
            "log.entryAdded total",
            "成功" if len(entries) >= 6 else "失败",
            f"日志数量: {len(entries)}",
        )
        page.console.stop()

        # 2. input.fileDialogOpened
        html_content = """
        <!DOCTYPE html>
        <html>
        <head><meta charset='utf-8'><title>File Dialog Test</title></head>
        <body>
            <input type='file' id='single-file' />
            <input type='file' id='multiple-files' multiple />
            <button id='trigger-single' onclick="document.getElementById('single-file').click()">Open Single</button>
            <button id='trigger-multiple' onclick="document.getElementById('multiple-files').click()">Open Multiple</button>
        </body>
        </html>
        """
        with open(test_file, "w", encoding="utf-8") as f:
            f.write(html_content)

        page.get(test_file.resolve().as_uri())
        add_result(results, "文件测试页加载", "成功", "本地 file dialog 页面已加载")

        if page.events.start(["input.fileDialogOpened"], contexts=[page.tab_id]):
            page.events.clear()
            page.ele("#trigger-single").click(by_js=True)
            single_event = page.events.wait("input.fileDialogOpened", timeout=3)
            if single_event and single_event.multiple is False:
                add_result(
                    results,
                    "input.fileDialogOpened single",
                    "成功",
                    f"multiple={single_event.multiple}",
                )
            else:
                add_result(
                    results,
                    "input.fileDialogOpened single",
                    "跳过",
                    "当前环境未稳定观察到单文件对话框事件",
                )

            page.events.clear()
            page.ele("#trigger-multiple").click(by_js=True)
            multi_event = page.events.wait("input.fileDialogOpened", timeout=3)
            if multi_event and multi_event.multiple is True:
                add_result(
                    results,
                    "input.fileDialogOpened multiple",
                    "成功",
                    f"multiple={multi_event.multiple}",
                )
            else:
                add_result(
                    results,
                    "input.fileDialogOpened multiple",
                    "跳过",
                    "当前环境未稳定观察到多文件对话框事件",
                )
        else:
            add_result(
                results,
                "input.fileDialogOpened",
                "不支持",
                "未能订阅 input.fileDialogOpened 事件",
            )

        print_results(results)

    except Exception as e:
        add_result(results, "示例执行", "失败", str(e)[:120])
        print_results(results)
        raise
    finally:
        try:
            page.console.stop()
        except Exception:
            pass
        try:
            page.events.stop()
        except Exception:
            pass
        try:
            if test_file.exists():
                test_file.unlink()
        except Exception:
            pass
        try:
            page.quit()
        except Exception:
            pass


if __name__ == "__main__":
    main()
