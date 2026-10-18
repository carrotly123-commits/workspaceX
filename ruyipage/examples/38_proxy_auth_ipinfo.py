# -*- coding: utf-8 -*-
"""
示例38: 通过 fpfile 自动处理 HTTP 代理认证

演示内容：
- 通过 set_proxy() 配置 HTTP 代理地址
- 通过 set_fpfile() 让内核自动读取 httpauth.username/password
- 访问 http://ipinfo.io/json 并打印返回内容
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ruyipage import FirefoxOptions, FirefoxPage


PROXY_HOST = "your-proxy-host"
PROXY_PORT = 8080
TARGET_URL = "http://ipinfo.io/json"
FPFILE_PATH = r"C:\Program Files\Mozilla Firefox\profile1.txt"
BROWSER_PATH = r"C:\Program Files\Mozilla Firefox\firefox.exe"
HEADLESS = False


def main():
    print("=" * 60)
    print("示例38: 通过 fpfile 自动处理 HTTP 代理认证")
    print("=" * 60)

    if not os.path.exists(FPFILE_PATH):
        raise FileNotFoundError("fpfile 不存在: {}".format(FPFILE_PATH))

    if not os.path.exists(BROWSER_PATH):
        raise FileNotFoundError("Firefox 不存在: {}".format(BROWSER_PATH))

    opts = FirefoxOptions()
    opts.set_browser_path(BROWSER_PATH)
    opts.set_proxy("http://{}:{}".format(PROXY_HOST, PROXY_PORT))
    opts.set_fpfile(FPFILE_PATH)
    opts.headless(HEADLESS)

    page = FirefoxPage(opts)

    try:
        print("\n0. 已启用代理自动认证:")
        print("   代理: http://{}:{}".format(PROXY_HOST, PROXY_PORT))
        print(f"   fpfile: {FPFILE_PATH}")
        print("   认证信息将由内核从 fpfile 自动读取")

        print(f"\n1. 通过代理访问: {TARGET_URL}")
        page.get(TARGET_URL)
        page.wait(3)

        title = page.title or ""
        print("\n2. 页面标题:")
        print(f"   {title}")

        body_text = (
            page.run_js("return document.body ? document.body.innerText : ''") or ""
        ).strip()

        print("\n3. 响应内容:")
        print(body_text)

        print("\n4. 解析返回内容:")
        data = _extract_ipinfo_from_page(page, body_text)

        if not isinstance(data, dict) or not data.get("ip"):
            raise RuntimeError("代理访问失败，未获取到有效的 ipinfo JSON 响应")

        print(f"   IP: {data.get('ip')}")
        print(f"   城市: {data.get('city')}")
        print(f"   地区: {data.get('region')}")
        print(f"   国家: {data.get('country')}")
        if data.get("status") or data.get("error") or data.get("message"):
            print(f"   状态: {data.get('status')}")
            print(f"   错误: {data.get('error')}")
            print(f"   消息: {data.get('message')}")

        print("\n" + "=" * 60)
        print("[OK] fpfile 代理认证示例执行完成")
        print("=" * 60)

    except Exception as e:
        print(f"\n[FAIL] 示例执行失败: {e}")
        raise
    finally:
        try:
            page.quit()
        except Exception:
            pass


def _extract_ipinfo_from_text(text):
    """从 ipinfo 页面展示文本中提取常见字段。"""
    if not text:
        return None

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    fields = {}
    keys = {
        "ip",
        "city",
        "region",
        "country",
        "loc",
        "org",
        "postal",
        "timezone",
        "readme",
    }

    for line_index, line in enumerate(lines):
        for key in keys:
            if line == key:
                if line_index + 1 < len(lines):
                    fields[key] = lines[line_index + 1].strip().strip('"')
                break

            prefix = key + "\t"
            if line.startswith(prefix):
                fields[key] = line[len(prefix) :].strip().strip('"')
                break

    return fields or None


def _extract_ipinfo_from_page(page, body_text):
    """兼容 ipinfo 的纯 JSON 和可视化 JSON 页面。"""
    try:
        data = json.loads(body_text)
        if isinstance(data, dict):
            return data
    except Exception:
        pass

    data = _extract_ipinfo_from_text(body_text)
    if isinstance(data, dict):
        return data

    try:
        script_text = page.run_js(
            """
            const root = document.querySelector('body');
            if (!root) return null;
            return root.innerText || '';
            """
        )
    except Exception:
        script_text = None

    if isinstance(script_text, str):
        data = _extract_ipinfo_from_text(script_text)
        if isinstance(data, dict):
            return data

    return None


if __name__ == "__main__":
    main()
