#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""示例29: Script + Input 高级能力（严格结果版）"""

import io
import os
import sys
from pathlib import Path
from typing import Dict, List


BASE_DIR = Path(__file__).resolve().parent

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

from ruyipage import FirefoxPage, ScriptResult


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
    print("测试 29: Script + Input 高级能力")
    print("=" * 70)

    page = FirefoxPage()
    results: List[Dict[str, str]] = []
    html_path = BASE_DIR / "test_file_input.html"
    file1 = BASE_DIR / "test1.txt"
    file2 = BASE_DIR / "test2.txt"

    try:
        page.get("https://www.example.com")
        add_result(results, "页面加载", "成功", "example.com 已加载")

        # 1. script.getRealms
        realms = page.get_realms()
        if realms:
            add_result(
                results, "script.getRealms all", "成功", f"realm 数量: {len(realms)}"
            )
        else:
            add_result(results, "script.getRealms all", "失败", "未返回任何 realm")

        window_realms = page.get_realms(type_="window")
        if window_realms:
            add_result(
                results,
                "script.getRealms window",
                "成功",
                f"window realm 数量: {len(window_realms)}",
            )
        else:
            add_result(
                results, "script.getRealms window", "失败", "未返回 window realm"
            )

        # 2. script.disown
        single: ScriptResult = page.eval_handle("({data: 'test', array: [1, 2, 3]})")
        if single.success and single.result.handle:
            page.disown_handles([single.result.handle])
            add_result(
                results,
                "script.disown single",
                "成功",
                f"handle={single.result.handle}",
            )
        else:
            add_result(results, "script.disown single", "跳过", "脚本结果未返回 handle")

        handles = []
        for i in range(3):
            item = page.eval_handle(f"({{id: {i}, value: 'test{i}'}})")
            if item.success and item.result.handle:
                handles.append(item.result.handle)
        if handles:
            page.disown_handles(handles)
            add_result(
                results, "script.disown batch", "成功", f"句柄数量: {len(handles)}"
            )
        else:
            add_result(results, "script.disown batch", "跳过", "未拿到可用 handle")

        # 3. input.setFiles 通过高层文件输入
        html_content = """
        <!DOCTYPE html>
        <html>
        <head><meta charset='utf-8'><title>File Input Test</title></head>
        <body>
            <input type='file' id='single-file' />
            <input type='file' id='multiple-files' multiple />
            <div id='result'></div>
            <script>
                document.getElementById('single-file').addEventListener('change', function(e) {
                    document.getElementById('result').textContent = 'Single file: ' + e.target.files[0].name;
                });
                document.getElementById('multiple-files').addEventListener('change', function(e) {
                    document.getElementById('result').textContent = 'Multiple files: ' + e.target.files.length;
                });
            </script>
        </body>
        </html>
        """

        with open(html_path, "w", encoding="utf-8") as f:
            f.write(html_content)
        with open(file1, "w", encoding="utf-8") as f:
            f.write("Test file 1 content")
        with open(file2, "w", encoding="utf-8") as f:
            f.write("Test file 2 content")

        page.get(html_path.resolve().as_uri())
        add_result(results, "文件测试页加载", "成功", "本地 file input 页面已加载")

        page.ele("#single-file").input(str(file1))
        single_text = page.ele("#result").text
        if "test1.txt" in single_text:
            add_result(results, "input.setFiles single", "成功", single_text)
        else:
            add_result(results, "input.setFiles single", "失败", single_text)

        page.ele("#multiple-files").input([str(file1), str(file2)])
        multi_text = page.ele("#result").text
        if "Multiple files: 2" in multi_text:
            add_result(results, "input.setFiles multiple", "成功", multi_text)
        else:
            add_result(results, "input.setFiles multiple", "失败", multi_text)

        print_results(results)

    except Exception as e:
        add_result(results, "示例执行", "失败", str(e)[:120])
        print_results(results)
        raise
    finally:
        for path in (file1, file2, html_path):
            try:
                if path.exists():
                    path.unlink()
            except Exception:
                pass
        try:
            page.quit()
        except Exception:
            pass


if __name__ == "__main__":
    main()
