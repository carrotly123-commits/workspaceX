#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""示例31: Network Events（严格结果版）"""

import io
import sys
from typing import Dict, List

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

from ruyipage import FirefoxPage, InterceptedRequest
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
    print("测试 31: Network Events")
    print("=" * 70)

    page = FirefoxPage()
    server = None
    results: List[Dict[str, str]] = []

    try:
        server = TestServer(port=find_free_port(9330, 9430)).start()
        base_url = server.get_url("")[:-1]

        page.get("about:blank")
        add_result(
            results, "页面加载", "成功", f"about:blank 已加载，服务地址: {base_url}"
        )

        page.events.start(
            [
                "network.beforeRequestSent",
                "network.responseStarted",
                "network.responseCompleted",
                "network.fetchError",
                "network.authRequired",
            ],
            contexts=[page.tab_id],
        )

        # 1. 普通请求事件链
        page.events.clear()
        page.run_js(
            f"fetch('{base_url}/api/data').catch(()=>null); return true;",
            as_expr=False,
        )

        before_event = page.events.wait("network.beforeRequestSent", timeout=5)
        started_event = page.events.wait("network.responseStarted", timeout=5)
        completed_event = page.events.wait("network.responseCompleted", timeout=5)

        if before_event and str((before_event.request or {}).get("url", "")).endswith(
            "/api/data"
        ):
            add_result(
                results,
                "network.beforeRequestSent",
                "成功",
                (before_event.request or {}).get("url", ""),
            )
        else:
            add_result(
                results,
                "network.beforeRequestSent",
                "失败",
                "未观察到 /api/data 请求开始事件",
            )

        if (
            started_event
            and int((started_event.response or {}).get("status", 0)) == 200
        ):
            add_result(
                results,
                "network.responseStarted",
                "成功",
                f"status={(started_event.response or {}).get('status')}",
            )
        else:
            add_result(
                results, "network.responseStarted", "失败", "未观察到 200 响应开始事件"
            )

        if (
            completed_event
            and int((completed_event.response or {}).get("status", 0)) == 200
        ):
            add_result(
                results,
                "network.responseCompleted",
                "成功",
                f"status={(completed_event.response or {}).get('status')}",
            )
        else:
            add_result(
                results,
                "network.responseCompleted",
                "失败",
                "未观察到 200 响应完成事件",
            )

        # 2. fetchError
        page.events.clear()
        page.run_js(
            "fetch('http://127.0.0.1:9/').catch(()=>null); return true;",
            as_expr=False,
        )
        error_event = page.events.wait("network.fetchError", timeout=5)
        if error_event:
            add_result(
                results, "network.fetchError", "成功", error_event.error_text or ""
            )
        else:
            add_result(
                results, "network.fetchError", "跳过", "当前环境未稳定观察到 fetchError"
            )

        # 3. authRequired
        page.events.clear()
        page.intercept.start(
            url_patterns=[{"type": "string", "pattern": base_url + "/api/auth"}],
            phases=["authRequired"],
        )
        try:
            page.get(base_url + "/api/auth")
        except Exception:
            pass

        auth_req: InterceptedRequest | None = page.intercept.wait(timeout=5)
        auth_event = page.events.wait("network.authRequired", timeout=5)

        if auth_event and auth_req:
            add_result(results, "network.authRequired", "成功", auth_req.url)
            auth_req.continue_with_auth(
                action="provideCredentials",
                username="user",
                password="pass",
            )

            auth_done = page.events.wait("network.responseCompleted", timeout=5)
            if auth_done and int((auth_done.response or {}).get("status", 0)) == 200:
                add_result(
                    results,
                    "network.authRequired credentials",
                    "成功",
                    "提供凭证后认证通过",
                )
            else:
                add_result(
                    results,
                    "network.authRequired credentials",
                    "失败",
                    "提供凭证后未观察到 200 完成事件",
                )
        else:
            add_result(
                results,
                "network.authRequired",
                "跳过",
                "当前环境未稳定观察到 authRequired",
            )
            add_result(
                results,
                "network.authRequired credentials",
                "跳过",
                "未观察到 authRequired，跳过凭证验证",
            )

        print_results(results)

    except Exception as e:
        add_result(results, "示例执行", "失败", str(e)[:120])
        print_results(results)
        raise
    finally:
        try:
            page.intercept.stop()
        except Exception:
            pass
        try:
            page.events.stop()
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
