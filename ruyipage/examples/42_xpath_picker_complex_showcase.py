# -*- coding: utf-8 -*-
"""示例42: XPath Picker 综合复杂场景展示页。

说明：
1) 启动时自动开启 XPath picker
2) 测试页拆分在 examples/test_pages 下，便于单独维护 HTML
3) 浏览器会保持打开，方便持续手动点选测试
4) 本示例不会主动调用 page.quit()
"""

import io
import os
import sys
import time
from pathlib import Path


if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


BASE_DIR = Path(__file__).resolve().parent

sys.path.insert(0, str(BASE_DIR.parent))

from ruyipage import launch


def main():
    test_page = BASE_DIR / "test_pages" / "xpath_picker_complex_showcase.html"
    file_url = test_page.resolve().as_uri()

    page = launch(
        headless=False,
        xpath_picker=True,
        window_size=(1600, 1100),
    )
    page.get(file_url)

    print("=" * 72)
    print("示例42: XPath Picker 综合复杂场景展示页")
    print("页面地址:", file_url)
    print("浏览器已保持打开，请手动点选页面中的复杂节点进行测试。")
    print(
        "可重点测试：元素校验实验区、元素组捕获实验区、主页面 shadow、outer iframe、inner iframe、SVG、contenteditable。"
    )
    print("建议步骤:")
    print("  1. 点击 '唯一稳定目标'，再点 XPath 校验按钮，确认显示唯一命中")
    print("  2. 点击 '重复命中目标 A/B'，再点校验，确认显示多命中和橙色高亮")
    print(
        "  3. 点击任意一张 capture-card，再点 '捕获相似元素'，检查元素组 Tab 和 page.eles() 代码"
    )
    print("  4. 在元素组 Tab 里尝试移除某项，确认列表和状态变化")
    print("按 Ctrl+C 结束脚本，浏览器不会由本示例主动关闭。")
    print("=" * 72)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n示例42结束。浏览器保持当前状态，已停止 Python 挂起循环。")


if __name__ == "__main__":
    main()
