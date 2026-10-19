# -*- coding: utf-8 -*-
"""
示例9: 标签页管理
测试功能：
- 新建标签页
- 切换标签页
- 关闭标签页
- 获取标签页列表
- 标签页操作
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


def test_tabs():
    """测试标签页管理功能"""
    print("=" * 60)
    print("测试9: 标签页管理")
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

        # 1. 获取当前标签页数量
        print("\n1. 获取当前标签页数量:")
        print(f"   标签页数量: {page.tabs_count}")

        tab2_url = "data:text/html,<html><head><title>Example Tab</title></head><body>tab2</body></html>"
        tab3_url = "data:text/html,<html><head><title>Wikipedia Tab</title></head><body>tab3</body></html>"

        # 2. 新建标签页
        print("\n2. 新建标签页:")
        tab2 = page.new_tab(tab2_url)
        page.wait(2)
        print(f"   ✓ 新标签页已创建")
        print(f"   新标签页标题: {tab2.title}")
        print(f"   当前标签页数量: {page.tabs_count}")

        # 3. 再新建一个标签页
        print("\n3. 再新建一个标签页:")
        tab3 = page.new_tab(tab3_url)
        page.wait(2)
        print(f"   ✓ 第三个标签页已创建")
        print(f"   标签页标题: {tab3.title}")
        print(f"   当前标签页数量: {page.tabs_count}")

        # 4. 获取所有标签页ID
        print("\n4. 获取所有标签页ID:")
        tab_ids = page.tab_ids
        print(f"   标签页ID列表: {tab_ids}")

        print("   当前页面 tab_id: {}".format(page.tab_id))

        # 5. 通过序号获取标签页
        print("\n5. 通过序号获取标签页:")
        first_tab = page.get_tab(1)
        print(f"   第1个标签页标题: {first_tab.title}")

        second_tab = page.get_tab(2)
        print(f"   第2个标签页标题: {second_tab.title}")

        # 6. 切换到第一个标签页
        print("\n6. 切换到第一个标签页:")
        first_tab.get(test_url)
        page.wait(1)
        print(f"   当前标题: {first_tab.title}")

        # 7. 获取最新的标签页
        print("\n7. 获取最新的标签页:")
        latest = page.latest_tab
        print(f"   最新标签页标题: {latest.title}")

        # 8. 通过标题查找标签页
        print("\n8. 通过标题查找标签页:")
        example_tab = page.get_tab(title="Example")
        if example_tab:
            print(f"   找到标签页: {example_tab.title}")
        else:
            print(f"   未找到包含'Example'的标签页")

        # 9. 通过URL查找标签页
        print("\n9. 通过URL查找标签页:")
        wiki_tab = page.get_tab(title="Wikipedia")
        if wiki_tab:
            print(f"   找到标签页: {wiki_tab.title}")
        else:
            print(f"   未找到包含'wikipedia'的标签页")

        # 10. 获取所有匹配的标签页
        print("\n10. 获取所有标签页:")
        all_tabs = page.get_tabs()
        print(f"   共有 {len(all_tabs)} 个标签页")
        for i, tab in enumerate(all_tabs, 1):
            print(f"   标签页{i}: {tab.title[:50]}")

        # 10.1 获取窗口句柄信息
        print("\n10.1 获取客户端窗口信息:")
        window_handles = page.browser.window_handles
        print(f"   clientWindows 数量: {len(window_handles)}")
        if window_handles:
            first_window = window_handles[0]
            print(f"   首个窗口状态: {first_window.get('state')}")

        # 10.2 读取 browsing context 树
        print("\n10.2 获取 browsing context 树:")
        tree = page.contexts.get_tree()
        contexts = tree.contexts
        print(f"   顶层 context 数量: {len(contexts)}")
        if contexts:
            print(f"   第一个 context: {contexts[0].context}")

        # 11. 关闭一个标签页
        print("\n11. 关闭第二个标签页:")
        second_tab.close()
        page.wait(1)
        print(f"   ✓ 标签页已关闭")
        print(f"   剩余标签页数量: {page.tabs_count}")

        # 12. 关闭其他标签页（保留第一个）
        print("\n12. 关闭其他标签页:")
        page.close_other_tabs(first_tab)
        page.wait(1)
        print(f"   ✓ 其他标签页已关闭")
        print(f"   剩余标签页数量: {page.tabs_count}")

        # 13. 新建后台标签页
        print("\n13. 新建后台标签页:")
        bg_tab = page.new_tab(tab2_url, background=True)
        page.wait(1)
        print(f"   ✓ 后台标签页已创建")
        print(f"   当前标签页数量: {page.tabs_count}")

        # 14. 激活标签页
        print("\n14. 激活后台标签页:")
        page.browser.activate_tab(bg_tab)
        page.wait(1)
        print(f"   ✓ 标签页已激活")

        # 15. 通过高层 context API 创建后台标签页
        print("\n15. 通过高层context API创建后台标签页:")
        bidi_tab_id = page.contexts.create_tab(
            background=True,
            reference_context=page.tab_id,
        )
        page.wait(1)
        print(f"   高层新标签页ID: {bidi_tab_id}")
        print(f"   当前标签页数量: {page.tabs_count}")

        # 清理纯 BiDi 新建的标签页，避免影响退出顺序
        bidi_tab = page.get_tab(bidi_tab_id)
        if bidi_tab:
            bidi_tab.close()
            page.wait(1)
            print("   ✓ 纯BiDi标签页已关闭")

        print("\n" + "=" * 60)
        print("✓ 所有标签页管理测试通过！")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        page.wait(2)
        page.quit()


if __name__ == "__main__":
    test_tabs()
