# -*- coding: utf-8 -*-
"""
示例37: 三个隔离 user context 页面
测试功能：
- 在同一个浏览器中创建三个 user context
- 每个 user context 创建一个独立页面
- 通过 httpbin 为每个页面设置不同 Cookie
- 验证三个页面之间 Cookie 不互串
"""

import json
import io
import os
import sys

# 设置控制台输出编码为UTF-8（Windows兼容）
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from ruyipage import FirefoxPage, FirefoxOptions


def cookies_to_dict(tab):
    """把当前页面 Cookie 列表转成字典。"""
    return {cookie.name: cookie.value for cookie in tab.get_cookies(all_info=True)}


def read_httpbin_cookies(tab):
    """读取 httpbin 返回的 cookies JSON。"""
    tab.get("https://httpbin.org/cookies")
    tab.wait(1)
    body_text = tab.ele("tag:body").text
    if not body_text.strip().startswith("{"):
        raise RuntimeError(
            "httpbin 返回内容不是 JSON: url={} body={!r}".format(
                tab.url, body_text[:200]
            )
        )
    return json.loads(body_text)


def print_tab_state(label, tab):
    """打印当前 tab 的 Cookie 可见状态。"""
    httpbin_data = read_httpbin_cookies(tab)
    print(f"   {label} -> httpbin返回: {httpbin_data}")
    print(f"   {label} -> API可见Cookie: {cookies_to_dict(tab)}")


def test_three_isolated_user_context_tabs():
    """单浏览器中三个 user context 页面互相隔离。"""
    print("=" * 60)
    print("测试37: 三个隔离 user context 页面")
    print("=" * 60)

    opts = FirefoxOptions()
    opts.headless(False)
    page = FirefoxPage(opts)

    user_contexts = []
    tab_ids = []

    try:
        print("\n1. 创建三个 user context:")
        for index in range(1, 4):
            user_context = page.browser_tools.create_user_context()
            user_contexts.append(user_context)
            print(f"   user context {index}: {user_context}")

        print("\n2. 在三个 user context 中分别创建页面:")
        for index, user_context in enumerate(user_contexts, 1):
            tab_id = page.browser_tools.create_tab(user_context=user_context)
            tab_ids.append(tab_id)
            print(f"   页面 {index}: context={tab_id}, userContext={user_context}")

        tab1 = page.get_tab(tab_ids[0])
        tab2 = page.get_tab(tab_ids[1])
        tab3 = page.get_tab(tab_ids[2])

        tabs = [tab1, tab2, tab3]
        values = ["alpha_ctx", "beta_ctx", "gamma_ctx"]
        cookie_name = "demo_user"
        cookie_urls = [
            f"https://httpbin.org/cookies/set?{cookie_name}={value}" for value in values
        ]

        print("\n3. 通过 httpbin 为每个页面设置不同 Cookie:")
        for index, (tab, url) in enumerate(zip(tabs, cookie_urls), 1):
            tab.get(url)
            tab.wait(1)
            print(f"   页面 {index} 已访问: {url}")

        print("\n4. 分别验证三个页面 Cookie 内容:")
        for index, tab in enumerate(tabs, 1):
            print_tab_state(f"页面 {index}", tab)

        result1 = read_httpbin_cookies(tab1).get("cookies", {}).get(cookie_name)
        result2 = read_httpbin_cookies(tab2).get("cookies", {}).get(cookie_name)
        result3 = read_httpbin_cookies(tab3).get("cookies", {}).get(cookie_name)

        print("\n5. 隔离结果校验:")
        print(f"   页面1 {cookie_name} = {result1}")
        print(f"   页面2 {cookie_name} = {result2}")
        print(f"   页面3 {cookie_name} = {result3}")

        if [result1, result2, result3] != values:
            raise RuntimeError("三个页面的 Cookie 结果与预期不一致，隔离校验失败")

        print("\n" + "=" * 60)
        print("✓ 三个 user context 页面 Cookie 已确认互相隔离")
        print("=" * 60)
        page.wait(20)
    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        for tab_id in tab_ids:
            try:
                tab = page.get_tab(tab_id)
                if tab:
                    tab.close()
            except Exception:
                pass

        for user_context in user_contexts:
            try:
                page.browser_tools.remove_user_context(user_context)
            except Exception:
                pass

        try:
            page.wait(20)
            page.quit()
        except Exception:
            pass


if __name__ == "__main__":
    test_three_isolated_user_context_tabs()
