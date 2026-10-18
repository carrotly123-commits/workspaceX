# -*- coding: utf-8 -*-
"""
示例3: 元素交互
测试功能：
- 点击元素
- 输入文本
- 清空输入
- 双击、右键点击
- 鼠标悬停
- 拖拽
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


def test_element_interaction():
    """测试元素交互功能"""
    print("=" * 60)
    print("测试3: 元素交互")
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

        # 1. 点击按钮
        print("\n1. 点击按钮:")
        click_btn = page.ele("#click-btn")
        click_btn.click_self()
        page.wait(0.5)
        result = page.ele("#click-result").text
        print(f"   点击结果: {result}")

        # 再点击几次
        click_btn.click_self()
        click_btn.click_self()
        page.wait(0.5)
        result = page.ele("#click-result").text
        print(f"   多次点击后: {result}")

        # 2. 输入文本
        print("\n2. 输入文本:")
        text_input = page.ele("#text-input")
        text_input.input("Hello RuyiPage!")
        page.wait(0.5)
        print(f"   输入的值: {text_input.value}")

        # 3. 清空并重新输入
        print("\n3. 清空并重新输入:")
        text_input.clear()
        text_input.input("新的文本内容")
        print(f"   新的值: {text_input.value}")

        # 4. 输入到其他类型的输入框
        print("\n4. 输入到不同类型的输入框:")
        page.ele("#email-input").input("test@example.com")
        page.ele("#password-input").input("password123")
        page.ele("#number-input").input("42")
        page.ele("#textarea").input("这是多行文本\n第二行\n第三行")
        print(f"   ✓ 所有输入框填写完成")

        # 5. 复选框操作
        print("\n5. 复选框操作:")
        checkbox1 = page.ele("#checkbox1")
        checkbox2 = page.ele("#checkbox2")
        print(f"   checkbox1初始状态: {checkbox1.is_checked}")
        checkbox1.click_self()
        page.wait(0.3)
        print(f"   checkbox1点击后: {checkbox1.is_checked}")
        checkbox2.click_self()
        page.wait(0.3)
        print(f"   checkbox2点击后: {checkbox2.is_checked}")

        # 6. 单选框操作
        print("\n6. 单选框操作:")
        radio1 = page.ele("#radio1")
        radio2 = page.ele("#radio2")
        radio1.click_self()
        page.wait(0.3)
        print(f"   radio1选中: {radio1.is_checked}")
        radio2.click_self()
        page.wait(0.3)
        print(f"   radio2选中: {radio2.is_checked}")
        print(f"   radio1现在: {radio1.is_checked}")

        # 7. 下拉选择
        print("\n7. 下拉选择:")
        select = page.ele("#select-single")
        # 教学建议：优先 native_only，失败再切 compat。
        select_ok = select.select.by_value("opt2", mode="native_only")
        if not select_ok:
            print("   native_only 失败，切换到 compat 模式保底...")
            select_ok = select.select.by_value("opt2", mode="compat")
        page.wait(0.5)
        print(f"   选中的值: {select.value}")
        selected = select.select.selected_option
        print(f"   选中的文本: {selected['text']}")
        print(f"   原生选择结果: {select_ok}")

        # 8. 双击
        print("\n8. 双击按钮:")
        dbl_btn = page.ele("#double-click-btn")
        dbl_btn.double_click()
        page.wait(0.5)
        result = page.ele("#click-result").text
        print(f"   双击结果: {result}")

        # 9. 右键点击
        print("\n9. 右键点击:")
        right_btn = page.ele("#right-click-btn")
        right_btn.right_click()
        page.wait(0.5)
        result = page.ele("#click-result").text
        print(f"   右键点击结果: {result}")

        # 10. 鼠标悬停
        print("\n10. 鼠标悬停:")
        hover_target = page.ele("#hover-target")
        hover_target.hover()
        page.wait(0.5)
        hover_result = page.ele("#hover-result").text
        print(f"   悬停结果: {hover_result}")

        # 11. 提交表单
        print("\n11. 提交表单:")
        submit_btn = page.ele("#submit-btn")
        submit_btn.click_self()
        page.wait(0.5)
        form_result = page.ele("#form-result").text
        print(f"   表单结果: {form_result[:50]}...")

        print("\n" + "=" * 60)
        print("✓ 所有元素交互测试通过！")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        page.wait(2)
        page.quit()


if __name__ == "__main__":
    test_element_interaction()
