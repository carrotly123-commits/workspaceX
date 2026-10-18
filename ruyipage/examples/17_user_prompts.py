# -*- coding: utf-8 -*-
"""示例17: 用户提示框处理（登录式步骤 API）

演示：
1) 自动策略 API
2) 步骤式 prompt 登录 API
3) 触发模式切换：mouse / keyboard
"""

import io
import os
import sys
from pathlib import Path


if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


BASE_DIR = Path(__file__).resolve().parent

sys.path.insert(0, str(BASE_DIR.parent))

from ruyipage import FirefoxOptions, FirefoxPage


def test_user_prompts():
    print("=" * 60)
    print("测试17: 用户提示框处理")
    print("=" * 60)

    opts = FirefoxOptions()
    opts.headless(False)
    opts.set_user_prompt_handler(
        {
            "alert": "accept",
            "confirm": "accept",
            "prompt": "ignore",
            "default": "accept",
        }
    )
    page = FirefoxPage(opts)

    try:
        test_page = BASE_DIR / "test_pages" / "native_user_prompts_test.html"
        test_url = test_page.resolve().as_uri()
        page.get(test_url)
        page.wait(0.8)

        page.set_prompt_handler(
            alert="accept",
            confirm="accept",
            prompt="ignore",
            default="accept",
            prompt_text="张三",
        )

        print("\n1. alert（自动策略）:")
        page.ele("#alert-btn").click_self()
        page.wait(0.3)
        print(f"   result: {page.ele('#alert-result').text}")

        print("\n2. confirm（自动策略）:")
        page.ele("#confirm-btn").click_self()
        page.wait(0.3)
        print(f"   result: {page.ele('#confirm-result').text}")
        print(f"   opened: {page.get_last_prompt_opened()}")
        print(f"   closed: {page.get_last_prompt_closed()}")

        print("\n3. prompt 登录（步骤式 API / mouse）:")
        page.clear_prompt_handler()
        page.get(test_url)
        page.wait(0.8)
        page.prompt_login(
            "#login-prompt-btn", "alice", "s3cr3t", trigger="mouse", timeout=2
        )
        page.wait(0.5)
        print(f"   result: {page.ele('#prompt-result').text}")

        print("\n4. prompt 登录（步骤式 API / keyboard）:")
        page.get(test_url)
        page.wait(0.8)
        page.prompt_login(
            "#login-prompt-btn", "bob", "654321", trigger="keyboard", timeout=2
        )
        page.wait(0.5)
        print(f"   result: {page.ele('#prompt-result').text}")

        print("\n" + "=" * 60)
        print("✓ 用户提示框自动策略 + 登录式步骤 API 测试完成！")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        try:
            page.clear_prompt_handler()
        except Exception:
            pass
        page.wait(1)
        page.quit()


if __name__ == "__main__":
    test_user_prompts()
