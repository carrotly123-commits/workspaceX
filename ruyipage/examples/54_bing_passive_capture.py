# -*- coding: utf-8 -*-
r"""Example 54: Passive packet capture with Bing.

This example demonstrates the new ``page.capture`` API:

1. Start capture before opening the page.
2. Open Bing search normally. The page can auto-load requests by itself.
3. Wait for one or many packets.
4. Read request headers/body and response headers/body directly.

Run:

    python examples/54_bing_passive_capture.py

Useful overrides:

    python examples/54_bing_passive_capture.py ^
        --browser-path C:\Program Files\Mozilla Firefox\firefox.exe ^
        --query ruyipage ^
        --count 5 ^
        --timeout 15
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
from typing import Any, Dict
from urllib.parse import quote_plus


if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ruyipage import launch  # noqa: E402


DEFAULT_BROWSER_PATH = os.getenv("RUYIPAGE_FIREFOX_PATH", "")


def preview(value: Any, limit: int = 800) -> str:
    """Return a compact one-line preview for large headers/bodies."""
    if value is None:
        return "None"
    if isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=False, indent=2)
    else:
        text = str(value)
    text = text.replace("\r", "\\r").replace("\n", "\\n")
    if len(text) > limit:
        return text[:limit] + "...<truncated>"
    return text


def packet_to_printable(packet, body_limit: int) -> Dict[str, Any]:
    """Convert a CapturePacket into readable output fields."""
    return {
        "url": packet.url,
        "method": packet.method,
        "request_id": packet.request_id,
        # 请求头：已转成普通 dict，key 统一为小写，方便直接 get。
        "request_headers": packet.request_headers,
        # 请求体：GET 通常没有请求体，所以常见结果是 None。
        # 如果抓 POST/PUT 包，这里会是解码后的字符串。
        "request_body_preview": preview(packet.request_body, body_limit),
        "response_status": packet.response_status,
        # 响应头：同样是普通 dict，key 统一为小写。
        "response_headers": packet.response_headers,
        # 响应体：由内部 DataCollector 自动等待、解码。
        # HTML/JSON/text/event-stream 都会尽量返回字符串。
        "response_body_preview": preview(packet.response_body, body_limit),
        "is_failed": packet.is_failed,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Capture Bing requests with page.capture"
    )
    parser.add_argument(
        "--browser-path",
        default=DEFAULT_BROWSER_PATH,
        help="Firefox executable path. Empty uses ruyiPage default resolution.",
    )
    parser.add_argument(
        "--proxy",
        default=os.getenv("RUYIPAGE_PROXY", ""),
        help="Proxy, for example http://127.0.0.1:7890. Empty disables it.",
    )
    parser.add_argument("--query", default="ruyipage", help="Bing search keyword.")
    parser.add_argument(
        "--target",
        default="bing.com",
        help=(
            "URL substring to capture. Use bing.com to capture page-load "
            "requests without depending on a private API path."
        ),
    )
    parser.add_argument(
        "--method",
        default="GET",
        help="HTTP method filter. Use empty string to capture all methods.",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=5,
        help="How many packets wait() should collect before returning.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=15,
        help="Max seconds to wait for packets.",
    )
    parser.add_argument(
        "--body-limit",
        type=int,
        default=800,
        help="Max characters printed for each request/response body preview.",
    )
    parser.add_argument("--headless", action="store_true", help="Run Firefox headless.")
    parser.add_argument(
        "--no-quit",
        action="store_true",
        help="Leave Firefox open after the script finishes.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    method = args.method.strip() or None
    proxy = args.proxy.strip() or None
    browser_path = args.browser_path.strip() or None
    search_url = "https://www.bing.com/search?q={}".format(quote_plus(args.query))

    page = None
    try:
        page = launch(
            browser_path=browser_path,
            proxy=proxy,
            headless=args.headless,
            window_size=(1280, 900),
        )

        # 关键点 1：抓自动加载包时，必须先 start，再打开页面。
        # 如果请求已经发出，任何监听/抓包接口都不能补抓历史包。
        #
        # targets 支持：
        # - True：抓全部请求
        # - "bing.com"：URL 包含 bing.com 就命中
        # - ["bing.com", "r.bing.com"]：任意一个命中即可
        #
        # method 支持 GET/POST/PUT/DELETE 等；None 表示不过滤 method。
        # collect_bodies=True 会自动采集请求体和响应体。
        page.capture.start(
            args.target,
            method=method,
            collect_bodies=True,
        )

        # 关键点 2：触发动作由外部正常写。这里打开 Bing 搜索页，
        # 页面加载时自动发出的请求会被 page.capture 捕获。
        page.get(search_url)

        # 关键点 3：支持抓多个包。count=1 时返回单个 CapturePacket 或 None；
        # count>1 时返回 list，超时则返回已抓到的部分。
        capture_result = page.capture.wait(timeout=args.timeout, count=max(args.count, 1))
        if isinstance(capture_result, list):
            packets = capture_result
        elif capture_result is None:
            packets = []
        else:
            packets = [capture_result]

        print("=" * 80)
        print("Bing passive capture")
        print("URL:", search_url)
        print("target:", args.target)
        print("method:", method or "<all>")
        print("wait returned:", len(packets), "packet(s)")
        print("history steps:", len(page.capture.steps), "packet(s)")
        print("=" * 80)

        for index, packet in enumerate(packets, 1):
            print("\n--- packet #{} ---".format(index))
            print(
                json.dumps(
                    packet_to_printable(packet, args.body_limit),
                    ensure_ascii=False,
                    indent=2,
                )
            )

        # 关键点 4：page.capture.steps 是本轮 start 后的历史包列表。
        # 如果你不知道会加载多少包，可以先 page.wait(3)，再读 steps。
        print("\nAll captured URLs:")
        for packet in page.capture.steps:
            print("[{}] {} {}".format(packet.response_status, packet.method, packet.url))

        return 0
    finally:
        if page is not None:
            try:
                # stop 会释放内部 DataCollector。已经返回的 packet 会尽量保留
                # 已读取到的 body 文本，后续仍可查看预览结果。
                page.capture.stop()
            except Exception:
                pass
            if not args.no_quit:
                page.quit()


if __name__ == "__main__":
    raise SystemExit(main())
