#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""示例23: 下载管理测试（严格结果版）"""

import io
import os
import shutil
import sys
from typing import List, Dict

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

from ruyipage import FirefoxPage
from ruyipage._functions.tools import find_free_port

from test_server import TestServer


def add_result(
    results: List[Dict[str, str]], item: str, status: str, note: str
) -> None:
    """记录结构化测试结果。"""
    results.append({"item": item, "status": status, "note": note})


def print_results(results: List[Dict[str, str]]) -> None:
    """打印固定格式结果表。"""
    print("\n| 项目 | 状态 | 说明 |")
    print("| --- | --- | --- |")
    for row in results:
        print(f"| {row['item']} | {row['status']} | {row['note']} |")


def build_download_page(base_url: str) -> str:
    """构造下载测试页。"""
    return """
    <!DOCTYPE html>
    <html>
    <head><meta charset='utf-8'><title>下载测试</title></head>
    <body>
        <button id='download-text'>下载文本文件</button>
        <button id='download-json'>下载JSON文件</button>
        <div id='status'></div>
        <script>
            function triggerDownload(url, statusText) {
                const a = document.createElement('a');
                a.href = url;
                a.click();
                document.getElementById('status').textContent = statusText;
            }

            document.getElementById('download-text').onclick = () => {
                triggerDownload('%s/download/text', '文本文件下载已触发');
            };

            document.getElementById('download-json').onclick = () => {
                triggerDownload('%s/download/json', 'JSON文件下载已触发');
            };
        </script>
    </body>
    </html>
    """ % (base_url, base_url)


def main() -> None:
    print("=" * 70)
    print("测试 23: Download 下载管理测试")
    print("=" * 70)

    page = FirefoxPage()
    server = None
    results: List[Dict[str, str]] = []
    download_path = os.path.abspath("E:/ruyipage/examples/downloads")
    text_path = os.path.join(download_path, "test.txt")
    json_path = os.path.join(download_path, "test.json")

    try:
        if os.path.exists(download_path):
            shutil.rmtree(download_path)
        os.makedirs(download_path, exist_ok=True)

        server = TestServer(port=find_free_port(8930, 9030)).start()
        base_url = server.get_url("")[:-1]

        # 1. 允许下载
        try:
            page.downloads.set_behavior("allow", path=download_path)
            add_result(
                results,
                "browser.setDownloadBehavior allow",
                "成功",
                f"下载目录: {download_path}",
            )
        except Exception as e:
            add_result(
                results, "browser.setDownloadBehavior allow", "失败", str(e)[:120]
            )
            raise

        # 2. 加载页面
        page.get("data:text/html;charset=utf-8," + build_download_page(base_url))
        add_result(
            results, "下载测试页加载", "成功", f"下载页已加载，服务地址: {base_url}"
        )

        # 3. 订阅下载事件
        subscribed = page.downloads.start()
        if subscribed:
            add_result(
                results,
                "下载事件订阅",
                "成功",
                "已订阅 downloadWillBegin / downloadEnd",
            )
        else:
            add_result(
                results, "下载事件订阅", "不支持", "当前浏览器未成功订阅下载事件"
            )

        # 4. 文本文件下载
        page.downloads.clear()
        page.ele("#download-text").click_self()
        begin_text, end_text = page.downloads.wait_chain(filename="test.txt", timeout=5)

        if begin_text:
            add_result(
                results,
                "downloadWillBegin text",
                "成功",
                f"filename={begin_text.suggested_filename or 'unknown'}",
            )
        else:
            add_result(
                results, "downloadWillBegin text", "失败", "5 秒内未收到开始事件"
            )

        if end_text:
            end_status = end_text.status or "unknown"
            add_result(results, "downloadEnd text", "成功", f"status={end_status}")
        else:
            add_result(results, "downloadEnd text", "失败", "5 秒内未收到结束事件")

        if page.downloads.wait_file(text_path, timeout=3):
            add_result(
                results, "text 文件落盘", "成功", f"{os.path.getsize(text_path)} bytes"
            )
        else:
            add_result(results, "text 文件落盘", "失败", "事件触发后仍未观察到文件落盘")

        # 5. JSON 文件下载
        page.downloads.clear()
        page.ele("#download-json").click_self()
        begin_json, end_json = page.downloads.wait_chain(
            filename="test.json", timeout=5
        )

        if begin_json:
            add_result(
                results,
                "downloadWillBegin json",
                "成功",
                f"filename={begin_json.suggested_filename or 'unknown'}",
            )
        else:
            add_result(
                results, "downloadWillBegin json", "失败", "5 秒内未收到开始事件"
            )

        if end_json:
            end_status = end_json.status or "unknown"
            add_result(results, "downloadEnd json", "成功", f"status={end_status}")
        else:
            add_result(results, "downloadEnd json", "失败", "5 秒内未收到结束事件")

        if page.downloads.wait_file(json_path, timeout=3):
            add_result(
                results, "json 文件落盘", "成功", f"{os.path.getsize(json_path)} bytes"
            )
        else:
            add_result(results, "json 文件落盘", "失败", "事件触发后仍未观察到文件落盘")

        # 6. deny 模式
        page.downloads.clear()
        try:
            page.downloads.set_behavior("deny")
            page.ele("#download-text").click_self()
            denied_begin = page.downloads.wait(
                method="browsingContext.downloadWillBegin",
                timeout=2,
                filename="test.txt",
            )
            if denied_begin:
                add_result(
                    results,
                    "browser.setDownloadBehavior deny",
                    "失败",
                    "deny 模式下仍出现下载开始事件",
                )
            else:
                add_result(
                    results,
                    "browser.setDownloadBehavior deny",
                    "成功",
                    "deny 模式下未观察到下载开始事件",
                )
        except Exception as e:
            add_result(
                results, "browser.setDownloadBehavior deny", "失败", str(e)[:120]
            )

        print_results(results)

    except Exception as e:
        add_result(results, "示例执行", "失败", str(e)[:120])
        print_results(results)
        raise
    finally:
        try:
            page.downloads.stop()
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
        if os.path.exists(download_path):
            shutil.rmtree(download_path)


if __name__ == "__main__":
    main()
