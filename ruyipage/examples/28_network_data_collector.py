#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""示例28: Network Data Collector（严格结果版）"""

import io
import sys
from typing import Dict, List

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

from ruyipage import DataCollector, DataPacket, FirefoxPage, InterceptedRequest
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
    print("测试 28: Network Data Collector")
    print("=" * 70)

    page = FirefoxPage()
    results: List[Dict[str, str]] = []
    collector: DataCollector | None = None
    server = None

    try:
        server = TestServer(port=find_free_port(9230, 9330)).start()
        base_url = server.get_url("")[:-1]

        page.get("about:blank")
        add_result(
            results, "页面加载", "成功", f"about:blank 已加载，服务地址: {base_url}"
        )

        page.network.set_extra_headers({"X-Test-Collector": "yes"})
        add_result(
            results, "network.setExtraHeaders", "成功", "已设置 X-Test-Collector"
        )

        try:
            page.network.set_cache_behavior("bypass")
            add_result(
                results, "network.setCacheBehavior", "成功", "缓存行为已设为 bypass"
            )
        except Exception as e:
            add_result(results, "network.setCacheBehavior", "不支持", str(e)[:120])

        collector = page.network.add_data_collector(
            ["responseCompleted"],
            data_types=["response"],
        )
        if collector.id:
            add_result(
                results, "network.addDataCollector", "成功", f"collector={collector.id}"
            )
        else:
            add_result(
                results, "network.addDataCollector", "失败", "未返回 collector ID"
            )

        page.intercept.start_requests()
        page.listen.start("/api/collector")
        page.run_js(
            f"fetch('{base_url}/api/collector').catch(()=>null); return true;",
            as_expr=False,
        )

        req: InterceptedRequest | None = page.intercept.wait(timeout=8)

        if req:
            has_header = "X-Test-Collector" in req.headers
            add_result(
                results,
                "request header injected",
                "成功" if has_header else "失败",
                f"request_id={req.request_id}, X-Test-Collector={has_header}",
            )
            req.continue_request()
        else:
            add_result(
                results,
                "request header injected",
                "失败",
                "未捕获到 beforeRequestSent 请求",
            )

        packet: DataPacket | None = page.listen.wait(timeout=8)

        if packet:
            add_result(
                results,
                "network.responseCompleted observed",
                "成功",
                f"status={packet.status} url={packet.url}",
            )
        else:
            add_result(
                results,
                "network.responseCompleted observed",
                "失败",
                "未在超时内观察到 responseCompleted",
            )

        if collector and req:
            got_response_data = False
            try:
                data = collector.get(req.request_id, data_type="response")
                if data.has_data:
                    got_response_data = True
                    add_result(
                        results,
                        "network.getData response",
                        "成功",
                        f"bytes={data.bytes} base64={'yes' if data.base64 else 'no'}",
                    )
                else:
                    add_result(
                        results, "network.getData response", "失败", f"raw={data.raw}"
                    )
            except Exception as e:
                add_result(results, "network.getData response", "失败", str(e)[:120])

            if got_response_data:
                try:
                    collector.disown(req.request_id, data_type="response")
                    add_result(
                        results, "network.disownData", "成功", "已释放 response 数据"
                    )
                except Exception as e:
                    add_result(results, "network.disownData", "失败", str(e)[:120])

                try:
                    data_after = collector.get(req.request_id, data_type="response")
                    if not data_after.has_data:
                        add_result(
                            results,
                            "network.getData after disown",
                            "成功",
                            "释放后已无可用数据",
                        )
                    else:
                        add_result(
                            results,
                            "network.getData after disown",
                            "跳过",
                            f"释放后仍可读取: {data_after.raw}",
                        )
                except Exception as e:
                    add_result(
                        results,
                        "network.getData after disown",
                        "成功",
                        f"释放后读取报错: {str(e)[:100]}",
                    )
            else:
                add_result(
                    results,
                    "network.disownData",
                    "跳过",
                    "未成功拿到 response 数据，跳过释放验证",
                )
                add_result(
                    results,
                    "network.getData after disown",
                    "跳过",
                    "未成功拿到 response 数据，跳过释放后验证",
                )

        if collector:
            try:
                collector.remove()
                add_result(
                    results,
                    "network.removeDataCollector",
                    "成功",
                    f"已移除 {collector.id}",
                )
                collector = None
            except Exception as e:
                add_result(results, "network.removeDataCollector", "失败", str(e)[:120])

        page.network.clear_extra_headers()
        add_result(results, "clear extra headers", "成功", "额外请求头已清理")

        print_results(results)

    except Exception as e:
        add_result(results, "示例执行", "失败", str(e)[:120])
        print_results(results)
        raise
    finally:
        try:
            page.listen.stop()
        except Exception:
            pass
        try:
            page.intercept.stop()
        except Exception:
            pass
        try:
            if server is not None:
                server.stop()
        except Exception:
            pass
        if collector:
            try:
                collector.remove()
            except Exception:
                pass
        try:
            page.network.clear_extra_headers()
        except Exception:
            pass
        try:
            page.quit()
        except Exception:
            pass


if __name__ == "__main__":
    main()
