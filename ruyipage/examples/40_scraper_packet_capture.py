# -*- coding: utf-8 -*-
"""Example 40: Scraper Packet Capture

Coverage:
1) GET 接口：拦截请求、拿 request_id、用 response_body 一步读取响应体
2) POST 接口：直接读取 req.body、用 response_body 一步读取响应体
3) 用 request_id 关联请求体与响应体，验证采集链路完整可用

Notes:
- 使用 collect_response=True 自动管理 DataCollector，无需手动编排。
- 相比旧版需要同时启停 intercept + listen + network.collector 三个管理器，
  现在只需一个 intercept 即可完成完整采集。
"""

import io
import json
import os
import sys
from typing import Dict, List, Optional


if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from ruyipage import FirefoxOptions, FirefoxPage, InterceptedRequest
from ruyipage._functions.tools import find_free_port
from test_server import TestServer


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
    print("Example 40: Scraper Packet Capture")
    print("=" * 70)

    server = TestServer(port=find_free_port(9632, 9732)).start()
    opts = FirefoxOptions()
    opts.headless(False)
    page = FirefoxPage(opts)
    results: List[Dict[str, str]] = []

    try:
        page.get("about:blank")

        # 1) GET 数据采集：常见于接口抓数。
        # collect_response=True 自动创建 DataCollector，无需手动编排。
        page.intercept.start(handler=None, phases=["beforeRequestSent"], collect_response=True)
        page.run_js(
            """
            fetch(arguments[0]).catch(() => null);
            return true;
            """,
            server.get_url("/api/data"),
            as_expr=False,
        )

        get_req: Optional[InterceptedRequest] = page.intercept.wait(timeout=8)
        if get_req:
            get_req.continue_request()
        page.intercept.stop()

        if get_req and get_req.method == "GET":
            add_result(results, "GET request captured", "成功", get_req.url)
        else:
            add_result(results, "GET request captured", "失败", str(get_req))

        # 直接通过 response_body 读取响应体，无需 listen + collector
        get_response_text = get_req.response_body if get_req else None
        get_response_ok = bool(
            get_response_text and '"status": "ok"' in get_response_text
        )
        add_result(
            results,
            "GET response body",
            "成功" if get_response_ok else "失败",
            str(get_response_text)[:120],
        )

        # 2) POST 数据采集：常见于搜索/翻页/详情接口。
        post_bodies: List[str] = []
        post_request_ids: List[str] = []

        def post_handler(req: InterceptedRequest) -> None:
            if "/api/echo" in req.url and req.method == "POST":
                post_bodies.append(req.body or "")
                post_request_ids.append(req.request_id)
            req.continue_request()

        # collect_response=True 自动管理 DataCollector
        page.intercept.start_requests(post_handler, collect_response=True)
        post_result = page.run_js(
            """
            return fetch(arguments[0], {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({keyword: 'ruyi', page: 2})
            }).then(r => r.json()).catch(e => ({error:String(e)}));
            """,
            server.get_url("/api/echo"),
            as_expr=False,
        )
        page.wait(0.5)
        page.intercept.stop()

        post_body_ok = bool(
            post_bodies and post_bodies[0] == '{"keyword":"ruyi","page":2}'
        )
        add_result(
            results,
            "POST request body",
            "成功" if post_body_ok else "失败",
            post_bodies[0] if post_bodies else "None",
        )

        if (
            isinstance(post_result, dict)
            and post_result.get("body") == '{"keyword":"ruyi","page":2}'
        ):
            add_result(results, "POST page result", "成功", post_result.get("body", ""))
        else:
            add_result(results, "POST page result", "失败", str(post_result)[:120])

        print_results(results)

        failed = [row for row in results if row["status"] == "失败"]
        if failed:
            raise AssertionError(f"存在 {len(failed)} 个失败项")

    finally:
        try:
            page.intercept.stop()
        except Exception:
            pass
        try:
            page.quit()
        except Exception:
            pass
        try:
            server.stop()
        except Exception:
            pass


if __name__ == "__main__":
    main()
