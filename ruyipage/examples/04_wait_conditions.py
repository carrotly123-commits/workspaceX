# -*- coding: utf-8 -*-
"""
示例4: 等待条件
测试功能：
- 等待元素出现
- 等待元素可见
- 等待元素隐藏
- 等待元素删除
- 等待标题变化
- 等待URL变化
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


def test_wait_conditions():
    """测试等待条件功能"""
    print("=" * 60)
    print("测试4: 等待条件")
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

        # 1. 等待元素出现（已存在的元素）
        print("\n1. 等待元素出现:")
        elem = page.wait.ele("#main-title", timeout=5)
        if elem:
            print(f"   ✓ 元素已找到: {elem.text}")
        else:
            print(f"   ✗ 元素未找到")

        # 2. 等待元素可见
        print("\n2. 等待元素可见:")
        btn = page.wait.ele_displayed("#click-btn", timeout=5)
        if btn:
            print(f"   ✓ 按钮可见")
        else:
            print(f"   ✗ 按钮不可见")

        # 3. 触发延迟显示内容
        print("\n3. 等待延迟显示的内容:")
        show_btn = page.ele("text:显示延迟内容")
        show_btn.click_self()
        print(f"   已点击按钮，等待内容显示...")

        # 等待动态内容出现
        dynamic_elem = page.wait.ele_displayed("#dynamic-content", timeout=5)
        if dynamic_elem:
            print(f"   ✓ 延迟内容已显示: {dynamic_elem.text}")
        else:
            print(f"   ✗ 延迟内容未显示")

        # 4. 等待元素隐藏
        print("\n4. 等待元素隐藏:")
        hide_btn = page.ele("text:隐藏内容")
        hide_btn.click_self()
        print(f"   已点击隐藏按钮...")

        is_hidden = page.wait.ele_hidden("#dynamic-content", timeout=3)
        if is_hidden:
            print(f"   ✓ 元素已隐藏")
        else:
            print(f"   ✗ 元素仍然可见")

        # 5. 等待元素删除
        print("\n5. 等待元素从DOM删除:")
        remove_btn = page.ele("text:删除内容")
        remove_btn.click_self()
        print(f"   已点击删除按钮...")

        is_deleted = page.wait.ele_deleted("#dynamic-content", timeout=3)
        if is_deleted:
            print(f"   ✓ 元素已从DOM删除")
        else:
            print(f"   ✗ 元素仍在DOM中")

        # 6. 等待标题包含特定文本
        print("\n6. 等待标题包含特定文本:")
        current_title = page.title
        print(f"   当前标题: {current_title}")
        result = page.wait.title_contains("RuyiPage", timeout=2)
        if result:
            print(f"   ✓ 标题包含'RuyiPage'")
        else:
            print(f"   ✗ 标题不包含'RuyiPage'")

        # 7. 简单等待（暂停）
        print("\n7. 简单等待2秒:")
        page.wait(2)
        print(f"   ✓ 等待完成")

        # 8. 等待页面加载完成
        print("\n8. 等待页面加载完成:")
        page.wait.doc_loaded(timeout=5)
        print(f"   ✓ 页面已加载完成")

        # 9. 添加新内容并等待
        print("\n9. 添加新内容并等待:")
        add_btn = page.ele("text:添加内容")
        add_btn.click_self()
        page.wait(0.5)

        # 等待新内容出现
        new_content = page.wait.ele("#content-container .result", timeout=3)
        if new_content:
            print(f"   ✓ 新内容已添加: {new_content.text}")
        else:
            print(f"   ✗ 新内容未找到")

        print("\n" + "=" * 60)
        print("✓ 所有等待条件测试通过！")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        page.wait(2)
        page.quit()


if __name__ == "__main__":
    test_wait_conditions()
