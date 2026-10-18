# -*- coding: utf-8 -*-
"""示例52: 单浏览器多个 container tab 使用不同 SOCKS5 密码代理。

要求：
1. 使用支持 ``proxy.rotate.*`` 的 ruyi 定制 Firefox 指纹内核。
2. 通过 ``FirefoxOptions.set_per_tab_proxies()`` 提供代理池。
3. 通过 ``page.new_container_tabs()`` 创建真正的 Firefox container tabs。

推荐用环境变量传代理，避免把密码写入源码或命令行历史：

    set RUYIPAGE_PROXY_1=host:port:username:password1
    set RUYIPAGE_PROXY_2=host:port:username:password2
    set RUYIPAGE_PROXY_3=host:port:username:password3
    set RUYIPAGE_PROXY_4=host:port:username:password4
    set RUYIPAGE_PROXY_5=host:port:username:password5
    python examples/52_per_tab_socks5_proxy_browserscan.py
"""

from __future__ import annotations

import os
import sys


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ruyipage import FirefoxOptions, FirefoxPage  # noqa: E402


DEFAULT_BROWSER_PATH = (
    r"E:\firefoxbrowser\firefox-fingerprintBrowser\firefox-151.0a1.en-US.win64\firefox\firefox.exe"
)
TARGET_URL = "https://browserscan.net/"


def load_proxies():
    proxies = []
    for index in range(1, 21):
        value = os.getenv("RUYIPAGE_PROXY_{}".format(index), "").strip()
        if value:
            proxies.append(value)
    return proxies


def main():
    proxies = load_proxies()
    if not proxies:
        raise SystemExit(
            "请先设置 RUYIPAGE_PROXY_1..N，格式 host:port:username:password 或 socks5://host:port:username:password"
        )

    browser_path = os.getenv("RUYIPAGE_FIREFOX_PATH", DEFAULT_BROWSER_PATH)

    print("=" * 60)
    print("示例52: per-tab SOCKS5 代理 + container tabs")
    print("=" * 60)
    print("Firefox:", browser_path)
    print("URL:", TARGET_URL)
    print("代理数量:", len(proxies))

    opts = FirefoxOptions()
    opts.set_browser_path(browser_path)
    opts.set_per_tab_proxies(proxies, exhausted="wrap")
    opts.set_window_size(1280, 900)
    opts.headless(False)
    opts.close_on_exit(False)

    page = FirefoxPage(opts)
    try:
        tabs = page.new_container_tabs(count=len(proxies), url=TARGET_URL)
        print("已创建 {} 个 container tabs。".format(len(tabs)))
        print("请人工查看每个 browserscan tab 的出口 IP/地区是否不同。")
        input("查看完成后按 Enter 关闭浏览器...")
    finally:
        page.quit()


if __name__ == "__main__":
    main()
