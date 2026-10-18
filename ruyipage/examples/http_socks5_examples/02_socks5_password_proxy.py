# -*- coding: utf-8 -*-
"""SOCKS5 密码代理示例：fpfile socksauth.*。

用法：
    set RUYIPAGE_SOCKS5_PROXY_1=gate.example.com:1000:REPLACE_WITH_SOCKS_USER:REPLACE_WITH_SOCKS_PASSWORD
    python examples/http_socks5_examples/02_socks5_password_proxy.py --headless

切换代理：
    python examples/http_socks5_examples/02_socks5_password_proxy.py --proxy-index 2

也可以直接传单条代理：
    python examples/http_socks5_examples/02_socks5_password_proxy.py --proxy gate.example.com:1000:REPLACE_WITH_SOCKS_USER:REPLACE_WITH_SOCKS_PASSWORD

说明：
1. 默认使用 ``python -m ruyipage install`` 安装/更新的 runtime 浏览器。
2. 如需手动指定浏览器，传 ``--browser-path`` 或设置 ``RUYIPAGE_FIREFOX_PATH``。
   如果默认 runtime 还没有 SOCKS5 认证支持，也可以用这里切到支持版指纹内核。
3. SOCKS5 密码认证写入临时 fpfile，使用 runtime 支持的 ``=`` 格式：
       socksauth.host=gate.example.com
       socksauth.port=1000
       socksauth.username=<username>
       socksauth.password=<password>
4. 这个示例不需要 ``set_proxy()``，框架会从 fpfile 读取 SOCKS5 host/port。
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


def write_socksauth_fpfile(path: str, proxy: dict[str, str | int]) -> None:
    # SOCKS5 认证字段使用等号格式，和 runtime 内核读取格式保持一致。
    with open(path, "w", encoding="utf-8") as f:
        f.write("socksauth.host={}\n".format(proxy["host"]))
        f.write("socksauth.port={}\n".format(proxy["port"]))
        f.write("socksauth.username={}\n".format(proxy["username"]))
        f.write("socksauth.password={}\n".format(proxy["password"]))


def read_page_text(page: FirefoxPage) -> str:
    try:
        page.wait.doc_loaded(timeout=30)
    except Exception:
        pass
    page.wait(1)
    return (page.run_js("return document.body ? document.body.innerText : ''") or "").strip()


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
    parser = argparse.ArgumentParser(description="ruyiPage SOCKS5 password proxy example")
    parser.add_argument("--proxy", help="host:port:username:password")
    parser.add_argument("--proxy-index", type=int, default=1, help="select RUYIPAGE_SOCKS5_PROXY_N")
    parser.add_argument("--target", default=TARGET_URL)
    parser.add_argument("--browser-path", default=os.getenv("RUYIPAGE_FIREFOX_PATH"))
    parser.add_argument("--headless", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    proxies = [args.proxy] if args.proxy else load_socks5_proxies()
    if not proxies:
        raise SystemExit(
            "请通过 --proxy 或 RUYIPAGE_SOCKS5_PROXY_1 提供 SOCKS5 代理，格式 host:port:username:password"
        )
    if args.proxy_index < 1 or args.proxy_index > len(proxies):
        raise SystemExit("--proxy-index must be 1..{}".format(len(proxies)))

    proxy = parse_socks5_proxy(proxies[args.proxy_index - 1])
    fpfile = tempfile.NamedTemporaryFile(
        "w", suffix="-ruyipage-socksauth.txt", delete=False, encoding="utf-8"
    )
    fpfile.close()
    profile_dir = tempfile.mkdtemp(prefix="ruyipage-socks5-proxy-")
    page = None

    try:
        write_socksauth_fpfile(fpfile.name, proxy)

        opts = FirefoxOptions()
        browser_path = choose_browser_path(args.browser_path)
        if browser_path:
            opts.set_browser_path(browser_path)
        opts.set_auto_port(True)
        opts.set_user_dir(profile_dir)
        # SOCKS5 host/port/username/password 全部从 fpfile 读取。
        opts.set_fpfile(fpfile.name)
        opts.set_window_size(900, 700)
        opts.headless(args.headless)

        page = FirefoxPage(opts)
        page.get(args.target)
        body_text = read_page_text(page)
        if not body_text:
            raise RuntimeError("empty response; SOCKS5 authentication may have failed")

        print("proxy=socks5://{}:{}".format(proxy["host"], proxy["port"]))
        print("username={}".format(proxy["username"]))
        print("target={}".format(args.target))
        print("exit_ip={}".format(body_text))
        return 0
    finally:
        if page is not None:
            page.quit()
        try:
            os.remove(fpfile.name)
        except OSError:
            pass
        shutil.rmtree(profile_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
