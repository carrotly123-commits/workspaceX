# -*- coding: utf-8 -*-
"""示例18: 高级网络功能（完整场景）

覆盖：
1) beforeRequestSent 拦截 + 继续请求
2) 修改请求头（dict headers）
3) mock 响应（dict headers）
4) 阻止请求
5) responseStarted 阶段读取 response_status / response_headers 并修改
6) 队列模式 wait() 手动处理
7) fetchError 事件监听
8) 直接读取请求体 req.body
9) GET 请求高频字段读取
10) collect_response + response_body 一步读取响应体
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
from ruyipage._functions.tools import find_free_port
from test_server import TestServer


def test_advanced_network():
    print("=" * 60)
    print("测试18: 高级网络功能")
    print("=" * 60)

    server = TestServer(port=find_free_port(8889, 8989))
    server.start()

    opts = FirefoxOptions()
    opts.headless(False)
    page = FirefoxPage(opts)

    fetch_error_list = []

    try:
        page.get("about:blank")
        page.wait(0.6)

        # 1) 请求拦截
        print("\n1. beforeRequestSent 拦截 + 继续请求:")
        intercepted = []

        def req_handler(req):
            if "/api/data" in req.url:
                intercepted.append(req.url)
                print(f"   拦截到请求: {req.method} {req.url}")
            req.continue_request()

        page.intercept.start_requests(req_handler)
        data = page.run_js(
            """
            return fetch(arguments[0]).then(r => r.json()).then(d => d.status).catch(e => String(e));
            """,
            server.get_url("/api/data"),
            as_expr=False,
        )
        page.wait(0.5)
        print(f"   请求结果: {data}")
        print(f"   拦截计数: {len(intercepted)}")
        page.intercept.stop()

        # 2) 修改请求头（dict headers）
        print("\n2. 修改请求头:")

        def header_handler(req):
            if "/api/headers" in req.url:
                # dict 格式自动转换为 BiDi 格式
                req.continue_request(
                    headers={
                        "X-Ruyi-Demo": "yes",
                        "User-Agent": "RuyiPage/Example18",
                    }
                )
                print("   ✓ 已注入请求头")
            else:
                req.continue_request()

        page.intercept.start_requests(header_handler)
        headers = page.run_js(
            """
            return fetch(arguments[0]).then(r => r.json()).catch(e => ({error:String(e)}));
            """,
            server.get_url("/api/headers"),
            as_expr=False,
        )
        print(
            f"   X-Ruyi-Demo: {headers.get('X-Ruyi-Demo') or headers.get('x-ruyi-demo')}"
        )
        page.intercept.stop()

        # 3) mock 响应（dict headers）
        print("\n3. mock 响应:")

        def mock_handler(req):
            if "/api/data" in req.url:
                req.mock(
                    '{"status":"mocked","data":{"message":"这是Mock数据"}}',
                    status_code=200,
                    headers={
                        "content-type": "application/json",
                        "access-control-allow-origin": "*",
                    },
                )
                print("   ✓ 已返回Mock响应")
            else:
                req.continue_request()

        page.intercept.start_requests(mock_handler)
        mock_msg = page.run_js(
            """
            return fetch(arguments[0]).then(r => r.json()).then(d => d.status + ':' + d.data.message).catch(e => String(e));
            """,
            server.get_url("/api/data"),
            as_expr=False,
        )
        print(f"   Mock结果: {mock_msg}")
        page.intercept.stop()

        # 4) 阻止请求
        print("\n4. 阻止请求:")

        def block_handler(req):
            if "/api/error" in req.url:
                req.fail()
                print("   ✓ 请求已阻止")
            else:
                req.continue_request()

        page.intercept.start_requests(block_handler)
        blocked = page.run_js(
            """
            return fetch(arguments[0]).then(() => 'unexpected-success').catch(e => 'blocked:' + e.name);
            """,
            server.get_url("/api/error"),
            as_expr=False,
        )
        print(f"   阻止结果: {blocked}")
        page.intercept.stop()

        # 5) responseStarted 阶段读取 + 修改状态码
        print("\n5. responseStarted 阶段读取 response_status 并修改:")

        def response_handler(req):
            if "/api/data" in req.url:
                print(f"   原始响应状态码: {req.response_status}")
                if req.response_headers:
                    ct = req.response_headers.get("content-type", "未知")
                    print(f"   原始 content-type: {ct}")
                req.continue_response(status_code=299, reason_phrase="RuyiModified")
                print("   ✓ 响应状态码已改为 299")
            else:
                req.continue_response()

        page.intercept.start_responses(response_handler)
        modified_status = page.run_js(
            """
            return fetch(arguments[0]).then(r => r.status + ':' + r.statusText).catch(e => String(e));
            """,
            server.get_url("/api/data"),
            as_expr=False,
        )
        print(f"   响应状态: {modified_status}")
        page.intercept.stop()

        # 6) 队列模式
        print("\n6. 队列模式 wait() 手动处理:")
        page.intercept.start(handler=None, phases=["beforeRequestSent"])
        page.run_js(
            """
            fetch(arguments[0]).catch(() => null);
            return 'sent';
            """,
            server.get_url("/api/data"),
            as_expr=False,
        )
        queued = page.intercept.wait(timeout=5)
        if queued:
            print(f"   wait捕获: {queued.method} {queued.url}")
            queued.continue_request()
        else:
            print("   ⚠ 未捕获到请求")
        page.intercept.stop()

        # 7) fetchError 事件监听
        print("\n7. fetchError 事件监听:")
        page.events.start(["network.fetchError"], contexts=[page.tab_id])
        page.events.clear()

        page.intercept.start_requests(block_handler)
        page.run_js(
            """
            fetch(arguments[0]).catch(() => null);
            return 'sent';
            """,
            server.get_url("/api/error"),
            as_expr=False,
        )
        page.wait(1)
        page.intercept.stop()
        while True:
            evt = page.events.wait("network.fetchError", timeout=0.2)
            if not evt:
                break
            fetch_error_list.append(evt)
        print(f"   fetchError 事件数量: {len(fetch_error_list)}")

        # 8) 直接读取请求体
        print("\n8. 直接读取请求体 req.body:")
        captured_bodies = []

        def body_handler(req):
            if "/api/echo" in req.url and req.method == "POST":
                captured_bodies.append(req.body)
                print(f"   捕获 body: {req.body}")
            req.continue_request()

        page.intercept.start_requests(body_handler)
        echoed = page.run_js(
            """
            return fetch(arguments[0], {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({message: 'hello-body'})
            }).then(r => r.json()).then(d => d.body).catch(e => String(e));
            """,
            server.get_url("/api/echo"),
            as_expr=False,
        )
        page.wait(0.5)
        print(f"   服务端收到: {echoed}")
        print(f"   拦截侧读取: {captured_bodies[-1] if captured_bodies else None}")
        page.intercept.stop()

        # 9) GET 请求高频字段读取
        print("\n9. GET 请求高频字段读取:")
        captured_get = []

        def get_fields_handler(req):
            if "/api/headers" in req.url:
                captured_get.append(req)
            req.continue_request()

        page.intercept.start_requests(get_fields_handler)
        get_resp = page.run_js(
            """
            return fetch(arguments[0]).then(r => r.json()).catch(e => ({error:String(e)}));
            """,
            server.get_url("/api/headers"),
            as_expr=False,
        )
        page.wait(0.5)
        page.intercept.stop()
        get_req = captured_get[0] if captured_get else None
        if get_req:
            print(
                f"   GET字段: method={get_req.method}, request_id={get_req.request_id}, body={get_req.body}"
            )
            print(f"   GET headers Accept: {get_req.headers.get('Accept')}")
        else:
            print("   ⚠ 未捕获到 GET 请求")
        print(f"   服务端返回类型: {type(get_resp).__name__}")

        # 10) collect_response + response_body 一步读取响应体
        print("\n10. collect_response + response_body 一步读取响应体:")
        page.intercept.start(handler=None, phases=["beforeRequestSent"], collect_response=True)
        page.run_js(
            """
            fetch(arguments[0], {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({mode: 'queue', value: 99})
            }).catch(() => null);
            return true;
            """,
            server.get_url("/api/echo"),
            as_expr=False,
        )
        queued_post = page.intercept.wait(timeout=8)
        if queued_post:
            print(
                f"   wait捕获POST: {queued_post.method} {queued_post.url} body={queued_post.body}"
            )
            queued_post.continue_request()
            # 无需手动编排 DataCollector，直接读取响应体
            resp_body = queued_post.response_body
            print(f"   response_body: {resp_body}")
        else:
            print("   ⚠ 未捕获到 POST 请求")
        page.wait(0.5)
        page.intercept.stop()

        print("\n" + "=" * 60)
        print("✓ 所有高级网络功能测试通过！")
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
        try:
            page.events.stop()
        except Exception:
            pass
        page.wait(1)
        page.quit()
        server.stop()


if __name__ == "__main__":
    test_advanced_network()
