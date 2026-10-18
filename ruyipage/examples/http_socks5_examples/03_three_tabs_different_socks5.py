# -*- coding: utf-8 -*-
"""3 个 container tab 分别使用不同 SOCKS5 密码代理。

用法：
    set RUYIPAGE_SOCKS5_PROXY_1=gate.example.com:1000:REPLACE_WITH_USER:REPLACE_WITH_PASSWORD_US_00000001_5m
    set RUYIPAGE_SOCKS5_PROXY_2=gate.example.com:1000:REPLACE_WITH_USER:REPLACE_WITH_PASSWORD_US_00000002_5m
    set RUYIPAGE_SOCKS5_PROXY_3=gate.example.com:1000:REPLACE_WITH_USER:REPLACE_WITH_PASSWORD_US_00000003_5m
    python examples/http_socks5_examples/03_three_tabs_different_socks5.py --headless

可视化调试：
    python examples/http_socks5_examples/03_three_tabs_different_socks5.py --hold

说明：
1. 默认使用 ``python -m ruyipage install`` 安装/更新的 runtime 浏览器。
2. 如需手动指定浏览器，传 ``--browser-path`` 或设置 ``RUYIPAGE_FIREFOX_PATH``。
   如果默认 runtime 还没有 proxy.rotate 支持，也可以用这里切到支持版指纹内核。
3. ``set_per_tab_proxies()`` 会生成运行期 fpfile，核心格式如下：
       proxy.rotate.enabled=true
       proxy.rotate.exhausted=stop
       proxy.rotate.proxy=socks5://host:port:username:password1
       proxy.rotate.proxy=socks5://host:port:username:password2
       proxy.rotate.proxy=socks5://host:port:username:password3
4. 必须用 ``new_container_tabs()`` 创建 container tabs，runtime 才能按 userContext/tab 分配代理。
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT_DIR))

from ruyipage import FirefoxOptions, FirefoxPage, resolve_firefox_path  # noqa: E402


TARGET_URL = "http://api.ipify.org"

SOCKS5_PROXY_ENV_PREFIX = "RUYIPAGE_SOCKS5_PROXY_"


def parse_socks5_proxy(value: str) -> dict[str, str | int]:
    host, port, username, password = value.split(":", 3)
    return {
        "host": host,
        "port": int(port),
        "username": username,
        "password": password,
    }


def mask_proxy(value: str) -> str:
    proxy = parse_socks5_proxy(value)
    return "socks5://{}:***@{}:{}".format(
        proxy["username"], proxy["host"], proxy["port"]
    )


def read_page_text(tab) -> str:
    try:
        tab.wait.doc_loaded(timeout=30)
    except Exception:
        pass
    tab.wait(1)
    return (tab.run_js("return document.body ? document.body.innerText : ''") or "").strip()


def choose_browser_path(value: str | None) -> str | None:
    # value 为空时 resolve_firefox_path(None) 会优先返回已安装/更新的 ruyipage runtime。
    return resolve_firefox_path(value)


def load_socks5_proxies() -> list[str]:
    proxies = []
    for index in range(1, 21):
        value = os.getenv("{}{}".format(SOCKS5_PROXY_ENV_PREFIX, index), "").strip()
        if value:
            proxies.append(value)
    return proxies


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="ruyiPage per-tab SOCKS5 proxy example")
    parser.add_argument("--count", type=int, default=3, help="number of container tabs")
    parser.add_argument("--target", default=TARGET_URL)
    parser.add_argument("--browser-path", default=os.getenv("RUYIPAGE_FIREFOX_PATH"))
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--hold", action="store_true", help="keep visible browser open until Enter")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    all_proxies = load_socks5_proxies()
    if not all_proxies:
        raise SystemExit(
            "请先设置 RUYIPAGE_SOCKS5_PROXY_1..N，格式 host:port:username:password"
        )
    if args.count < 1 or args.count > len(all_proxies):
        raise SystemExit("--count must be 1..{}".format(len(all_proxies)))

    proxies = all_proxies[: args.count]
    profile_dir = tempfile.mkdtemp(prefix="ruyipage-per-tab-socks5-")
    page = None

    try:
        opts = FirefoxOptions()
        browser_path = choose_browser_path(args.browser_path)
        if browser_path:
            opts.set_browser_path(browser_path)
        opts.set_auto_port(True)
        opts.set_user_dir(profile_dir)
        # 这里会在 profile 里生成 ruyipage_per_tab_proxy_fp.txt。
        opts.set_per_tab_proxies(proxies, exhausted="stop")
        opts.set_window_size(1280, 900)
        opts.headless(args.headless)

        page = FirefoxPage(opts)
        tabs = page.new_container_tabs(count=args.count)

        print("target={}".format(args.target))
        exit_ips = []
        for index, tab in enumerate(tabs, start=1):
            url = args.target
            separator = "&" if "?" in url else "?"
            tab.get("{}{}tab={}".format(url, separator, index))
            body_text = read_page_text(tab)
            if not body_text:
                raise RuntimeError("tab{} empty response; per-tab SOCKS5 may have failed".format(index))
            exit_ips.append(body_text)
            print("tab{} proxy={} exit_ip={}".format(index, mask_proxy(proxies[index - 1]), body_text))

        if len(set(exit_ips)) != len(exit_ips):
            print("warning=some tabs returned the same exit IP; check proxy provider session reuse")

        if args.hold:
            input("Press Enter to close browser...")
        return 0
    finally:
        if page is not None:
            page.quit()
        shutil.rmtree(profile_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
