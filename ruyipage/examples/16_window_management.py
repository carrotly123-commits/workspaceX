# -*- coding: utf-8 -*-
"""示例16: 浏览器窗口管理（完整场景）

测试覆盖：
1) 窗口/视口/页面尺寸与位置
2) 窗口状态流：normal -> maximize -> minimize -> fullscreen -> normal
3) 设置窗口大小、位置、居中
4) 多标签创建、激活、切换、关闭
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


def test_window_management():
    """测试浏览器窗口管理功能"""
    print("=" * 60)
    print("测试16: 浏览器窗口管理")
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

        # 1. 获取当前窗口大小
        print("\n1. 获取当前窗口大小:")
        size = page.rect.window_size
        print(f"   窗口大小: {size[0]} x {size[1]}")

        # 2. 获取视口大小
        print("\n2. 获取视口大小:")
        viewport = page.rect.viewport_size
        print(f"   视口大小: {viewport[0]} x {viewport[1]}")

        # 3. 获取窗口位置
        print("\n3. 获取窗口位置:")
        location = page.rect.window_location
        print(f"   窗口位置: ({location[0]}, {location[1]})")

        # 4. 获取页面完整大小
        print("\n4. 获取页面完整大小:")
        page_size = page.rect.page_size
        print(f"   页面大小: {page_size[0]} x {page_size[1]}")

        # 5. 获取滚动位置
        print("\n5. 获取滚动位置:")
        scroll_pos = page.rect.scroll_position
        print(f"   滚动位置: ({scroll_pos[0]}, {scroll_pos[1]})")

        # 6. 滚动页面并检查位置
        print("\n6. 滚动页面并检查位置:")
        page.scroll.to_bottom()
        page.wait(0.5)
        new_scroll = page.rect.scroll_position
        print(f"   滚动后位置: ({new_scroll[0]}, {new_scroll[1]})")

        # 6.1 窗口状态流
        print("\n6.1 窗口状态流测试:")
        page.window.maximize()
        page.wait(0.5)
        print(f"   maximize 后窗口大小: {page.rect.window_size}")

        page.window.minimize()
        page.wait(0.5)
        print("   ✓ minimize 已调用")

        page.window.fullscreen()
        page.wait(0.5)
        print(f"   fullscreen 后视口大小: {page.rect.viewport_size}")

        page.window.normal()
        page.wait(0.5)
        print("   ✓ normal 已恢复")

        # 6.2 设置窗口尺寸与位置并居中
        print("\n6.2 设置窗口尺寸/位置/居中:")
        page.window.set_size(1200, 820)
        page.window.set_position(40, 40)
        page.wait(0.5)
        print(f"   调整后窗口大小: {page.rect.window_size}")
        print(f"   调整后窗口位置: {page.rect.window_location}")

        page.window.center()
        page.wait(0.5)
        print(f"   居中后窗口位置: {page.rect.window_location}")

        # 7. 创建新标签页
        print("\n7. 创建新标签页:")
        new_tab = page.new_tab()
        page.wait(1)
        print(f"   ✓ 新标签页已创建")

        # 8. 在新标签页中打开页面
        print("\n8. 在新标签页中打开页面:")
        new_tab.get("https://www.example.com")
        new_tab.wait(2)
        print(f"   新标签页URL: {new_tab.url}")
        print(f"   新标签页标题: {new_tab.title}")

        # 9. 切换回原标签页
        print("\n9. 切换回原标签页:")
        # 使用 browser.activate_tab 显式切回原 tab
        page.browser.activate_tab(page.tab_id)
        page.wait(0.5)
        page.get(test_url)
        page.wait(0.5)
        print(f"   当前标签页标题: {page.title}")

        # 9.1 新建后台标签页并激活
        print("\n9.1 后台标签页激活测试:")
        bg_tab = page.new_tab("https://www.example.com", background=True)
        page.wait(1)
        print(f"   后台标签页ID: {bg_tab.tab_id}")
        page.browser.activate_tab(bg_tab)
        page.wait(1)
        print(f"   激活后标题: {bg_tab.title}")

        # 切回主 tab，避免后续关闭干扰
        page.browser.activate_tab(page.tab_id)
        page.wait(0.5)

        # 10. 关闭新标签页
        print("\n10. 关闭新标签页:")
        new_tab.close()
        try:
            bg_tab.close()
        except Exception:
            pass
        page.wait(0.5)
        print(f"   ✓ 新标签页已关闭")

        print("\n" + "=" * 60)
        print("✓ 所有窗口管理测试通过！")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        page.wait(2)
        page.quit()


if __name__ == "__main__":
    test_window_management()
