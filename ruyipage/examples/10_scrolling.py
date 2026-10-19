# -*- coding: utf-8 -*-
"""
示例10: 滚动操作
测试功能：
- 滚动到顶部/底部
- 滚动到元素
- 滚动指定距离
- 元素内滚动
"""

import os
import sys
import io
from pathlib import Path

# 设置控制台输出编码为UTF-8（Windows兼容）
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

BASE_DIR = Path(__file__).resolve().parent

sys.path.insert(0, str(BASE_DIR.parent))

from ruyipage import FirefoxPage, FirefoxOptions


def test_scrolling():
    """测试滚动操作功能"""
    print("=" * 60)
    print("测试10: 滚动操作")
    print("=" * 60)

    opts = FirefoxOptions()
    opts.headless(False)
    page = FirefoxPage(opts)

    try:
        # 加载测试页面
        test_page = BASE_DIR / "test_pages" / "test_page.html"
        test_url = test_page.resolve().as_uri()
        page.get(test_url)
        page.wait(1)

        # 1. 滚动到页面底部
        print("\n1. 滚动到页面底部:")
        page.actions.scroll(0, 4000).perform()
        page.wait(1)
        print(f"   ✓ 已滚动到底部")

        # 2. 滚动到页面顶部
        print("\n2. 滚动到页面顶部:")
        page.actions.scroll(0, -4000).perform()
        page.wait(1)
        print(f"   ✓ 已滚动到顶部")

        # 3. 滚动到特定元素
        print("\n3. 滚动到特定元素:")
        table_section = page.ele("#table-section")
        while not table_section.states.is_in_viewport:
            page.actions.scroll(0, 500).perform()
            page.wait(0.2)
        page.wait(1)
        print(f"   ✓ 已滚动到表格区域")

        # 4. 滚动指定像素
        print("\n4. 向下滚动500像素:")
        page.actions.scroll(0, 500).perform()
        page.wait(1)
        print(f"   ✓ 已向下滚动")

        # 5. 向上滚动
        print("\n5. 向上滚动300像素:")
        page.actions.scroll(0, -300).perform()
        page.wait(1)
        print(f"   ✓ 已向上滚动")

        # 6. 滚动到元素使其可见
        print("\n6. 滚动到元素使其可见:")
        form_section = page.ele("#form-section")
        while not form_section.states.is_in_viewport:
            page.actions.scroll(0, -400).perform()
            page.wait(0.2)
        page.wait(1)
        print(f"   ✓ 元素已滚动到可见区域")

        # 7. 元素内部滚动
        print("\n7. 元素内部滚动:")
        scroll_container = page.ele("#scroll-container")

        # 滚动容器到可见区域
        while not scroll_container.states.is_in_viewport:
            page.actions.scroll(0, 400).perform()
            page.wait(0.2)
        page.wait(0.5)

        # 在容器内滚动
        scroll_container.scroll.to_bottom()
        page.wait(1)
        print(f"   ✓ 容器已滚动到底部")

        scroll_container.scroll.to_top()
        page.wait(1)
        print(f"   ✓ 容器已滚动到顶部")

        # 8. 滚动到容器内的元素
        print("\n8. 滚动到容器内的元素:")
        scroll_target = page.ele("#scroll-target")
        scroll_container.scroll.to_see(scroll_target)
        page.wait(1)
        print(f"   ✓ 已滚动到目标元素")

        # 9. 获取滚动位置
        print("\n9. 获取页面滚动位置:")
        scroll_pos = page.run_js("return {x: window.scrollX, y: window.scrollY}")
        print(
            f"   当前滚动位置: X={scroll_pos.get('x', 0)}, Y={scroll_pos.get('y', 0)}"
        )

        # 10. 平滑滚动
        print("\n10. 平滑滚动到顶部:")
        page.actions.scroll(0, -4000).perform()
        page.wait(2)
        print(f"   ✓ 平滑滚动完成")

        # 11. 滚动到页面特定位置
        print("\n11. 滚动到页面中间:")
        page.actions.scroll(0, 500).perform()
        page.wait(1)
        print(f"   ✓ 已滚动到指定位置")

        # 12. 将元素滚动到视图
        print("\n12. 将元素滚动到视图:")
        network_section = page.ele("#network-section")
        while not network_section.states.is_in_viewport:
            page.actions.scroll(0, 450).perform()
            page.wait(0.2)
        page.wait(1)
        print(f"   ✓ 元素已滚动到视图")

        print("\n" + "=" * 60)
        print("✓ 所有滚动操作测试通过！")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        page.wait(2)
        page.quit()


if __name__ == "__main__":
    test_scrolling()
