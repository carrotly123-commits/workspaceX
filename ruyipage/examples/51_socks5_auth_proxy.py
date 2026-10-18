# -*- coding: utf-8 -*-
"""示例51: 使用带账号密码的 SOCKS5 代理访问网站。

运行示例::

    python examples/51_socks5_auth_proxy.py --host 127.0.0.1 --port 1080 --username <username> --password <password>

示例会先用 curl 验证代理本身可用，再把认证信息写入临时 fpfile::

    socksauth.host:127.0.0.1
    socksauth.port:1080
    socksauth.username:<username>
    socksauth.password:<password>

也可以用环境变量避免在命令行历史里暴露密码::

    set RUYIPAGE_SOCKS5_HOST=127.0.0.1
    set RUYIPAGE_SOCKS5_PORT=1080
    set RUYIPAGE_SOCKS5_USERNAME=<username>
    set RUYIPAGE_SOCKS5_PASSWORD=<password>
    python examples/51_socks5_auth_proxy.py
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ruyipage import launch  # noqa: E402


TARGET_URL = "http://ipinfo.io/json"


def write_proxy_fpfile(path: str, host: str, port: int, username: str, password: str) -> None:
    """Write SOCKS5 proxy and auth fields to an fp file."""
    with open(path, "w", encoding="utf-8") as f:
        f.write("socksauth.host:{}\n".format(host))
        f.write("socksauth.port:{}\n".format(int(port)))
        f.write("socksauth.username:{}\n".format(username))
        f.write("socksauth.password:{}\n".format(password))


def curl_check_proxy(host: str, port: int, username: str, password: str, target: str) -> bool:
    proxy = "{}:{}@{}:{}".format(username, password, host, int(port))
    cmd = [
        "curl.exe" if os.name == "nt" else "curl",
        "--socks5-hostname",
        proxy,
        "--connect-timeout",
        "20",
        "--max-time",
        "40",
        target,
    ]
    print("\n[curl] 先验证 SOCKS5 代理连通性...")
    result = subprocess.run(cmd, text=True, capture_output=True)
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.returncode != 0:
        if result.stderr.strip():
            print(result.stderr.strip())
        print("[curl] 代理预检失败，跳过 Firefox 测试。")
        return False
    print("[curl] 代理预检成功。")
    return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="ruyiPage SOCKS5 password proxy example")
    parser.add_argument("--host", default=os.getenv("RUYIPAGE_SOCKS5_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("RUYIPAGE_SOCKS5_PORT", "1080")))
    parser.add_argument("--username", default=os.getenv("RUYIPAGE_SOCKS5_USERNAME"))
    parser.add_argument("--password", default=os.getenv("RUYIPAGE_SOCKS5_PASSWORD"))
    parser.add_argument("--target", default=os.getenv("RUYIPAGE_PROXY_TEST_URL", TARGET_URL))
    parser.add_argument(
        "--browser-path",
        default=os.getenv("RUYIPAGE_FIREFOX_PATH"),
        help="Firefox executable path; fingerprint browser builds that support socksauth.* are recommended",
    )
    parser.add_argument("--headless", action="store_true", help="run Firefox in headless mode")
    parser.add_argument("--skip-curl-check", action="store_true", help="skip curl proxy preflight")
    parser.add_argument("--keep-fpfile", action="store_true", help="keep the generated fp file for debugging")
    parser.add_argument("--keep-profile", action="store_true", help="keep the generated Firefox profile for debugging")
    parser.add_argument("--no-quit", action="store_true", help="leave Firefox open after the script finishes")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.username or not args.password:
        raise SystemExit("请通过 --username/--password 或 RUYIPAGE_SOCKS5_USERNAME/RUYIPAGE_SOCKS5_PASSWORD 提供代理认证信息。")

    print("=" * 60)
    print("示例51: 使用 SOCKS5 密码代理")
    print("=" * 60)
    print("代理: socks5://{}:{}@{}:{}".format(args.username, "***", args.host, args.port))
    print("测试地址: {}".format(args.target))

    if not args.skip_curl_check:
        if not curl_check_proxy(args.host, args.port, args.username, args.password, args.target):
            return 2

    with tempfile.NamedTemporaryFile("w", suffix="-ruyipage-socks5.txt", delete=False, encoding="utf-8") as f:
        fpfile_path = f.name
    profile_dir = tempfile.mkdtemp(prefix="ruyipage-socks5-profile-")

    page = None
    try:
        write_proxy_fpfile(fpfile_path, args.host, args.port, args.username, args.password)
        print("fp 文件: {}".format(fpfile_path))
        print("profile: {}".format(profile_dir))

        page = launch(
            headless=args.headless,
            browser_path=args.browser_path,
            user_dir=profile_dir,
            fpfile=fpfile_path,
        )
        page.get(args.target)
        page.wait.doc_loaded(timeout=30)
        page.wait(2)

        body_text = (page.run_js("return document.body ? document.body.innerText : ''") or "").strip()
        print("\n响应内容:")
        print(body_text)
        if not body_text:
            raise RuntimeError("页面响应为空，代理可能连接失败或认证失败")

        try:
            data = json.loads(body_text)
        except Exception:
            data = None

        if isinstance(data, dict):
            print("\n出口信息:")
            print("  IP: {}".format(data.get("ip")))
            print("  国家: {}".format(data.get("country")))
            print("  地区: {}".format(data.get("region")))
            print("  城市: {}".format(data.get("city")))

        print("\n[OK] SOCKS5 密码代理示例执行完成")
        return 0
    finally:
        if page is not None and not args.no_quit:
            page.quit()
        if not args.keep_fpfile:
            try:
                os.remove(fpfile_path)
            except OSError:
                pass
        if not args.keep_profile:
            import shutil

            shutil.rmtree(profile_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
