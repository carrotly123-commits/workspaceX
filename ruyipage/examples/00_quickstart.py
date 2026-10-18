# -*- coding: utf-8 -*-
"""
示例01: 一步上手

面向新手：最少代码完成一次页面访问与元素交互。
"""

import io
import sys


if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


from ruyipage import launch


def quickstart_demo():
    print("=" * 60)
    print("示例01: 一步上手")
    print("=" * 60)

    page = launch(headless=False)

    try:
        page.get("https://example.com")
        page.wait(1)
        print(f"标题: {page.title}")

        h1 = page.ele("tag:h1")
        print(f"H1文本: {h1.text}")

        print("\n✓ 快速上手完成")
    finally:
        page.wait(1)
        page.quit()


if __name__ == "__main__":
    quickstart_demo()
