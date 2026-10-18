# -*- coding: utf-8 -*-
"""示例14: Shadow DOM + 嵌套 iframe（open/closed 完整场景）

覆盖点：
1) 主页面 open shadow
2) 主页面 closed shadow（Firefox BiDi privileged 通道）
3) 进入 iframe 后 open shadow
4) 进入 iframe 后 closed shadow（Firefox BiDi privileged 通道）
5) with_frame / with_shadow 简洁 API
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


def test_shadow_dom():
    print("=" * 60)
    print("测试14: Shadow DOM + 嵌套iframe")
    print("=" * 60)

    opts = FirefoxOptions()
    opts.headless(False)
    page = FirefoxPage(opts)

    try:
        test_page = BASE_DIR / "test_pages" / "complex_shadow_iframe.html"
        test_url = test_page.resolve().as_uri()
        page.get(test_url)
        page.wait(1)

        # 1) 主页面 open shadow
        print("\n1. 主页面 open shadow:")
        host_open = page.ele("#host-open-shadow")
        with host_open.with_shadow("open") as open_root:
            text = open_root.ele("#host-open-text").text
            print(f"   open文本: {text}")

        # 2) 主页面 closed shadow
        print("\n2. 主页面 closed shadow:")
        host_closed = page.ele("#host-closed-shadow")
        with host_closed.with_shadow("closed") as closed_root:
            text = closed_root.ele("#host-closed-text").text
            print(f"   closed文本: {text}")

        # 3) 进入 iframe，测试 open/closed shadow
        print("\n3. 进入iframe并测试 shadow:")
        with page.with_frame("#outer-iframe") as frame:
            inner_title = frame.ele("#inner-title").text
            print(f"   iframe标题: {inner_title}")

            inner_open = frame.ele("#inner-open-host")
            with inner_open.with_shadow("open") as inner_open_root:
                open_text = inner_open_root.ele("#inner-open-text").text
                print(f"   iframe open文本: {open_text}")

            inner_closed = frame.ele("#inner-closed-host")
            with inner_closed.with_shadow("closed") as inner_closed_root:
                closed_text = inner_closed_root.ele("#inner-closed-text").text
                print(f"   iframe closed文本: {closed_text}")

        # 4) 退出 with_frame 后仍可访问主页面
        print("\n4. 退出iframe后主页面可访问:")
        host_title = page.ele("#host-title").text
        print(f"   主页面标题: {host_title}")

        print("\n" + "=" * 60)
        print("✓ Shadow DOM + 嵌套iframe 测试通过！")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        page.wait(1)
        page.quit()


if __name__ == "__main__":
    test_shadow_dom()
