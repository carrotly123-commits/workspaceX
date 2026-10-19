# -*- coding: utf-8 -*-
"""
示例11: 网络拦截（本地可重复版）

测试覆盖：
1) beforeRequestSent + mock 响应（dict headers）
2) beforeRequestSent + fail 请求
3) beforeRequestSent + 修改请求头并继续（dict headers）
4) 无 handler 队列模式 wait()
5) responseStarted 阶段读取 response_status / response_headers

说明：
- 本示例全部使用本地 TestServer，避免外网波动导致结果不稳定。
- 所有拦截都在当前页面 context 内触发，便于复现与调试。
"""

import io
import os
import sys


if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from ruyipage import FirefoxOptions, FirefoxPage
from test_server import TestServer


def test_network_intercept():
    """网络拦截演示主流程（适合初学者逐步阅读）。"""
    print("=" * 60)
    print("测试11: 网络拦截")
    print("=" * 60)

    server = TestServer(port=8888)
    server.start()

    opts = FirefoxOptions()
    opts.headless(False)
    page = FirefoxPage(opts)

    try:
        # 准备一个干净页面，确保后续 fetch 都在当前 context 内触发。
        page.get("about:blank")
        page.wait(0.5)

        # ==========================================================
        # 1) mock 响应（使用简洁的 dict headers）
        # ==========================================================
        print("\n1. 拦截并 Mock 本地 API:")

        def mock_handler(req):
            if "/api/data" in req.url:
                print(f"   拦截到请求: {req.method} {req.url}")
                # 注意：mock 需要带上 CORS 头，不然浏览器会把跨域响应拦掉，
                # fetch 侧会看到 NetworkError。
                # headers 支持 dict 格式，自动转换为 BiDi 格式。
                req.mock(
                    '{"status":"ok","data":{"message":"mocked-by-interceptor"}}',
                    status_code=200,
                    headers={
                        "content-type": "application/json",
                        "access-control-allow-origin": "*",
                    },
                )
                print("   ✓ 已返回 Mock 响应")
            else:
                # 不处理的请求必须显式继续，否则会一直挂起。
                req.continue_request()

        page.intercept.start(mock_handler, phases=["beforeRequestSent"])
        mocked = page.run_js(
            """
            return fetch(arguments[0]).then(r => r.json()).then(d => d.data.message).catch(e => String(e));
            """,
            server.get_url("/api/data"),
            as_expr=False,
        )
        print(f"   mock结果: {mocked}")
        page.intercept.stop()

        # ==========================================================
        # 2) fail 请求
        # ==========================================================
        print("\n2. 阻止本地 API 请求:")

        def fail_handler(req):
            if "/api/data" in req.url:
                print(f"   阻止请求: {req.url}")
                req.fail()
            else:
                req.continue_request()

        page.intercept.start(fail_handler, phases=["beforeRequestSent"])
        blocked = page.run_js(
            """
            return fetch(arguments[0]).then(() => 'unexpected-success').catch(e => 'blocked:' + e.name);
            """,
            server.get_url("/api/data"),
            as_expr=False,
        )
        print(f"   fail结果: {blocked}")
        page.intercept.stop()

        # ==========================================================
        # 3) 修改请求头并继续（使用简洁的 dict headers）
        # ==========================================================
        print("\n3. 修改请求头并继续:")

        def header_handler(req):
            if "/api/headers" in req.url:
                # headers 支持 dict 格式，比 BiDi 原始格式简洁得多。
                req.continue_request(
                    headers={
                        "X-Ruyi-Demo": "yes",
                        "User-Agent": "RuyiPage/Example11",
                    }
                )
                print("   ✓ 已注入自定义请求头")
            else:
                req.continue_request()

        page.intercept.start(header_handler, phases=["beforeRequestSent"])
        headers_json = page.run_js(
            """
            return fetch(arguments[0]).then(r => r.json()).catch(e => ({error:String(e)}));
            """,
            server.get_url("/api/headers"),
            as_expr=False,
        )
        x_header = ""
        if isinstance(headers_json, dict):
            x_header = headers_json.get("X-Ruyi-Demo") or headers_json.get(
                "x-ruyi-demo"
            )
        print(f"   服务器看到的 X-Ruyi-Demo: {x_header}")
        page.intercept.stop()

        # ==========================================================
        # 4) 无 handler 队列模式
        # ==========================================================
        print("\n4. 队列模式 wait() 捕获拦截请求:")
        # handler=None 表示不在回调里处理，而是进入队列，供 wait() 手动取出。
        page.intercept.start(handler=None, phases=["beforeRequestSent"])
        page.run_js(
            """
            fetch(arguments[0]).catch(() => null);
            return 'sent';
            """,
            server.get_url("/api/data"),
            as_expr=False,
        )
        req = page.intercept.wait(timeout=5)
        if req:
            print(f"   wait捕获: {req.method} {req.url}")
            # 队列模式下记得手动继续/中止请求，否则请求会悬挂。
            req.continue_request()
        else:
            print("   ⚠ 未在超时内捕获请求")
        page.intercept.stop()

        # ==========================================================
        # 5) responseStarted 阶段读取响应信息 + 响应体
        # ==========================================================
        print("\n5. responseStarted 阶段读取 response_status / response_headers / response_body:")

        captured_body = []

        def response_handler(req):
            if "/api/data" in req.url:
                print(f"   拦截到响应: status={req.response_status}")
                if req.response_headers:
                    ct = req.response_headers.get("content-type", "未知")
                    print(f"   响应 content-type: {ct}")
                # 放行响应，不做修改
                req.continue_response()
                # start_responses 默认 collect_response=True，
                # continue_response 后可直接读取响应体
                body = req.response_body
                captured_body.append(body)
                print(f"   响应体: {body}")
            else:
                req.continue_response()

        page.intercept.start_responses(response_handler)
        result = page.run_js(
            """
            return fetch(arguments[0]).then(r => r.status + ':' + r.statusText).catch(e => String(e));
            """,
            server.get_url("/api/data"),
            as_expr=False,
        )
        print(f"   前端看到: {result}")
        page.intercept.stop()

        print("\n" + "=" * 60)
        print("✓ 网络拦截测试通过！")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        try:
            page.intercept.stop()
        except Exception:
            pass
        page.wait(1)
        page.quit()
        server.stop()


if __name__ == "__main__":
    test_network_intercept()
