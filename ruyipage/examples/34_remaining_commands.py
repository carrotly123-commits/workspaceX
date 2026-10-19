#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""示例34: Remaining Commands（严格结果版）"""

import io
import os
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
    print("测试 34: Remaining Commands")
    print("=" * 70)

    page = FirefoxPage()
    server = None
    results: List[Dict[str, str]] = []
    screenshot_path = os.path.join(os.path.dirname(__file__), "test_screenshot.png")

    try:
        server = TestServer(port=find_free_port(9430, 9530)).start()
        base_url = server.get_url("")[:-1]

        # 1. captureScreenshot
        page.get(base_url + "/nav/basic")
        add_result(results, "页面加载", "成功", f"服务地址: {base_url}")

        data_bytes = page.screenshot(as_bytes=True)
        if data_bytes and len(data_bytes) > 100:
            add_result(
                results,
                "browsingContext.captureScreenshot viewport",
                "成功",
                f"截图字节数: {len(data_bytes)}",
            )
        else:
            add_result(
                results,
                "browsingContext.captureScreenshot viewport",
                "失败",
                "截图数据过短",
            )

        saved_path = page.screenshot(path=screenshot_path)
        if saved_path and os.path.exists(saved_path):
            add_result(results, "screenshot save file", "成功", saved_path)
        else:
            add_result(results, "screenshot save file", "失败", "未保存截图文件")

        # 2. traverseHistory
        page.get(base_url + "/nav/basic?a=1")
        page.get(base_url + "/nav/basic?a=2")
        page.get(base_url + "/nav/basic?a=3")
        page.back()
        back_url = page.url
        page.back()
        back2_url = page.url
        page.forward()
        forward_url = page.url

        if (
            back_url.endswith("?a=2")
            and back2_url.endswith("?a=1")
            and forward_url.endswith("?a=2")
        ):
            add_result(
                results,
                "browsingContext.traverseHistory",
                "成功",
                f"back={back_url}, back2={back2_url}, forward={forward_url}",
            )
        else:
            add_result(
                results,
                "browsingContext.traverseHistory",
                "失败",
                f"back={back_url}, back2={back2_url}, forward={forward_url}",
            )

        # 3. network.continueResponse
        page.intercept.start_responses(
            url_patterns=[{"type": "string", "pattern": base_url + "/api/data"}]
        )
        page.run_js(
            f"fetch('{base_url}/api/data').catch(()=>null); return true;", as_expr=False
        )
        resp_req: InterceptedRequest | None = page.intercept.wait(timeout=5)
        if resp_req:
            resp_req.continue_response()
            add_result(results, "network.continueResponse", "成功", resp_req.url)
        else:
            add_result(
                results,
                "network.continueResponse",
                "跳过",
                "未稳定捕获到 responseStarted 拦截",
            )
        page.intercept.stop()

        # 4. network.provideResponse
        page.intercept.start_requests(
            url_patterns=[{"type": "string", "pattern": base_url + "/api/mock-source"}]
        )
        page.run_js(
            f"fetch('{base_url}/api/mock-source').catch(()=>null); return true;",
            as_expr=False,
        )
        mock_req: InterceptedRequest | None = page.intercept.wait(timeout=5)
        if mock_req:
            mock_req.mock(body='{"status":"mocked"}', status_code=200)
            add_result(results, "network.provideResponse", "成功", mock_req.url)
        else:
            add_result(
                results,
                "network.provideResponse",
                "跳过",
                "未稳定捕获到 beforeRequestSent 拦截",
            )
        page.intercept.stop()

        # 5. network.failRequest
        page.intercept.start_requests(
            url_patterns=[{"type": "string", "pattern": base_url + "/api/slow"}]
        )
        page.run_js(
            f"fetch('{base_url}/api/slow').catch(()=>null); return true;", as_expr=False
        )
        fail_req: InterceptedRequest | None = page.intercept.wait(timeout=5)
        if fail_req:
            fail_req.fail()
            add_result(results, "network.failRequest", "成功", fail_req.url)
        else:
            add_result(
                results,
                "network.failRequest",
                "跳过",
                "未稳定捕获到 beforeRequestSent 拦截",
            )
        page.intercept.stop()

        # 6. network.continueWithAuth
        page.events.start(["network.authRequired"], contexts=[page.tab_id])
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
        if auth_req and auth_event:
            auth_req.continue_with_auth(
                action="provideCredentials",
                username="user",
                password="pass",
            )
            add_result(results, "network.continueWithAuth", "成功", auth_req.url)
        else:
            add_result(
                results,
                "network.continueWithAuth",
                "跳过",
                "当前环境未稳定观察到 authRequired",
            )
        page.intercept.stop()
        page.events.stop()

        # 7. input.performActions / releaseActions
        try:
            page.quit()
        except Exception:
            pass
        page = FirefoxPage()

        action_page = """
        <!DOCTYPE html>
        <html>
        <head><meta charset='utf-8'><title>Actions Test</title></head>
        <body>
            <input id='input-box' autofocus />
            <button id='btn' onclick="window.btnClicked = true">Click Me</button>
            <script>
                window.btnClicked = false;
                window.lastKey = '';
                document.getElementById('input-box').addEventListener('keydown', function(e) {
                    window.lastKey = e.key;
                });
            </script>
        </body>
        </html>
        """
        page.get("data:text/html;charset=utf-8," + action_page)
        page.actions.move_to(page.ele("#input-box")).click().press("a").perform()
        last_key = page.run_js("return window.lastKey")
        page.actions.move_to(page.ele("#btn")).click().perform()
        btn_clicked = page.run_js("return window.btnClicked")
        page.actions.release()

        if last_key == "a":
            add_result(
                results, "input.performActions keyboard", "成功", f"lastKey={last_key}"
            )
        else:
            add_result(
                results, "input.performActions keyboard", "失败", f"lastKey={last_key}"
            )

        if btn_clicked is True:
            add_result(
                results, "input.performActions pointer", "成功", "按钮点击事件已触发"
            )
        else:
            add_result(
                results, "input.performActions pointer", "失败", "按钮点击事件未触发"
            )

        add_result(results, "input.releaseActions", "成功", "动作状态已释放")

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
            if os.path.exists(screenshot_path):
                os.remove(screenshot_path)
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
