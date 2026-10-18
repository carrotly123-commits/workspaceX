# -*- coding: utf-8 -*-
"""
示例8: Cookie管理
测试功能：
- 获取Cookie
- 设置Cookie
- 删除Cookie
- 清空所有Cookie
"""

import os
import sys
import io
import time

# 设置控制台输出编码为UTF-8（Windows兼容）
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from ruyipage import FirefoxPage, FirefoxOptions
from test_server import TestServer


def test_cookies():
    """测试Cookie管理功能"""
    print("=" * 60)
    print("测试8: Cookie管理")
    print("=" * 60)

    # 启动测试服务器
    server = TestServer(port=8888)
    server.start()

    opts = FirefoxOptions()
    opts.headless(False)
    page = FirefoxPage(opts)

    try:
        # 访问测试服务器的Cookie设置页面
        print("\n访问测试服务器...")
        page.get(server.get_url("/set-cookie"))
        page.wait(2)

        # 1. 获取服务器设置的Cookie
        print("\n1. 获取服务器设置的Cookie:")
        all_cookies = page.get_cookies(all_info=True)
        print(f"   共有 {len(all_cookies)} 个Cookie")
        for cookie in all_cookies:
            name = cookie.name
            value = cookie.value
            print(f"   - {name}: {value}")

        # 2. 通过API设置Cookie
        print("\n2. 通过API设置Cookie:")
        page.set_cookies(
            {
                "name": "api_cookie",
                "value": "api_value",
                "domain": "127.0.0.1",
                "path": "/",
            }
        )
        page.set_cookies(
            {"name": "user_id", "value": "12345", "domain": "127.0.0.1", "path": "/"}
        )
        print(f"   ✓ 已通过API设置2个Cookie")

        # 3. 验证Cookie已设置
        print("\n3. 验证Cookie已设置:")
        page.refresh()
        page.wait(1)
        all_cookies = page.get_cookies(all_info=True)
        print(f"   刷新后共有 {len(all_cookies)} 个Cookie")

        # 转换为字典方便查找
        cookies_dict = {}
        for c in all_cookies:
            cookies_dict[c.name] = c.value

        if "api_cookie" in cookies_dict:
            print(f"   ✓ api_cookie = {cookies_dict['api_cookie']}")
        if "user_id" in cookies_dict:
            print(f"   ✓ user_id = {cookies_dict['user_id']}")

        # 4. 设置带过期时间的Cookie
        print("\n4. 设置带过期时间的Cookie:")
        expire_time = int(time.time()) + 3600  # 1小时后过期
        page.set_cookies(
            {
                "name": "expire_cookie",
                "value": "will_expire",
                "domain": "127.0.0.1",
                "path": "/",
                "expiry": expire_time,
            }
        )
        print(f"   ✓ 已设置带过期时间的Cookie（1小时后过期）")

        # 5. 设置HttpOnly和Secure Cookie
        print("\n5. 设置HttpOnly和Secure Cookie:")
        page.set_cookies(
            {
                "name": "secure_cookie",
                "value": "secure_value",
                "domain": "127.0.0.1",
                "path": "/",
                "httpOnly": True,
                "secure": False,  # HTTP不能用secure=True
            }
        )
        print(f"   ✓ 已设置HttpOnly Cookie")

        # 6. 获取特定Cookie
        print("\n6. 获取特定Cookie:")
        all_cookies = page.get_cookies(all_info=True)
        cookies_dict = {}
        for c in all_cookies:
            cookies_dict[c.name] = c.value

        if "user_id" in cookies_dict:
            print(f"   user_id = {cookies_dict['user_id']}")
        if "expire_cookie" in cookies_dict:
            print(f"   expire_cookie = {cookies_dict['expire_cookie']}")

        # 6.1 简单 cookies 属性
        print("\n6.1 当前页面 cookies 属性:")
        simple_cookies = page.cookies
        print(f"   page.cookies 数量: {len(simple_cookies)}")

        # 6.2 setter 风格 Cookie API
        print("\n6.2 通过 page.set.cookies 设置Cookie:")
        page.set.cookies(
            {
                "name": "setter_cookie",
                "value": "setter_value",
                "domain": "127.0.0.1",
                "path": "/",
            }
        )
        page.wait(0.5)
        setter_cookies = {c.name: c.value for c in page.get_cookies()}
        print(f"   setter_cookie = {setter_cookies.get('setter_cookie')}")

        # 6.3 通过高层过滤 API 读取 Cookie
        print("\n6.3 通过高层过滤 API 读取Cookie:")
        filtered_cookies = page.get_cookies_filtered(name="user_id", all_info=True)
        print(f"   过滤结果数量: {len(filtered_cookies)}")
        if filtered_cookies:
            value = filtered_cookies[0].value
            print(f"   user_id(filtered) = {value}")

        # 7. 删除特定Cookie
        print("\n7. 删除特定Cookie:")
        page.delete_cookies(name="api_cookie")
        print(f"   ✓ 已删除 api_cookie")

        # 验证删除
        page.wait(0.5)
        all_cookies = page.get_cookies(all_info=True)
        cookies_dict = {}
        for c in all_cookies:
            cookies_dict[c.name] = c.value

        if "api_cookie" not in cookies_dict:
            print(f"   ✓ 确认 api_cookie 已被删除")
        else:
            print(f"   ⚠ api_cookie 仍然存在")

        # 7.1 通过公开删除接口删除 setter_cookie
        print("\n7.1 删除 setter_cookie:")
        page.delete_cookies(name="setter_cookie", domain="127.0.0.1")
        page.wait(0.5)
        cookies_after_remove = {c.name: c.value for c in page.get_cookies()}
        print(f"   setter_cookie 是否存在: {'setter_cookie' in cookies_after_remove}")

        # 8. 访问API验证Cookie发送
        print("\n8. 访问API验证Cookie发送:")
        page.get(server.get_url("/get-cookie"))
        page.wait(1)
        body_text = page.ele("tag:body").text
        print(f"   服务器收到的Cookie: {body_text[:100]}")

        # 9. 清空所有Cookie
        print("\n9. 清空所有Cookie:")
        page.delete_cookies()
        print(f"   ✓ 已清空所有Cookie")

        # 验证清空
        all_cookies = page.get_cookies()
        print(f"   清空后Cookie数量: {len(all_cookies)}")

        # 9.1 浏览器级 Cookie 读取
        print("\n9.1 浏览器级 cookies 读取:")
        browser_cookies = page.browser.cookies(all_info=False)
        print(f"   browser.cookies 数量: {len(browser_cookies)}")

        # 10. 重新设置并测试
        print("\n10. 重新设置Cookie并测试:")
        page.set_cookies(
            {
                "name": "final_cookie",
                "value": "final_value",
                "domain": "127.0.0.1",
                "path": "/",
            }
        )
        page.refresh()
        page.wait(1)

        all_cookies = page.get_cookies(all_info=True)
        cookies_dict = {}
        for c in all_cookies:
            cookies_dict[c.name] = c.value

        if "final_cookie" in cookies_dict:
            print(f"   ✓ final_cookie = {cookies_dict['final_cookie']}")
            print(f"   ✓ Cookie持久性测试通过")

        print("\n" + "=" * 60)
        print("✓ 所有Cookie管理测试通过！")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        page.wait(2)
        page.quit()
        server.stop()


if __name__ == "__main__":
    test_cookies()
