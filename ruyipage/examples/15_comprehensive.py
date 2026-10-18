# -*- coding: utf-8 -*-
"""
示例15: 综合测试 - 实战场景
测试功能：
- 模拟真实的网页自动化场景
- 综合运用多种功能
- 表单填写和提交
- 数据提取
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


def test_comprehensive():
    """综合测试 - 实战场景"""
    print("=" * 60)
    print("测试15: 综合测试 - 实战场景")
    print("=" * 60)

    opts = FirefoxOptions()
    opts.enable_action_visual(True)
    opts.headless(False)
    page = FirefoxPage(opts)

    try:
        # 加载测试页面
        test_page = BASE_DIR / "test_pages" / "test_page.html"
        test_url = test_page.resolve().as_uri()
        page.get(test_url)
        page.wait(1)

        print("\n场景1: 填写并提交表单")
        print("-" * 40)

        # 1. 填写文本输入框
        print("1. 填写表单字段...")
        page.ele("#text-input").input("张三")
        page.ele("#email-input").input("zhangsan@example.com")
        page.ele("#password-input").input("password123")
        page.ele("#number-input").input("25")
        page.ele("#textarea").input("这是一段测试文本\n包含多行内容")

        # 2. 选择复选框
        page.ele("#checkbox1").click_self()
        page.ele("#checkbox2").click_self()

        # 3. 选择单选框
        page.ele("#radio1").click_self()

        # 4. 选择下拉框
        select_ele = page.ele("#select-single")
        select_ok = select_ele.select.by_value("opt2", mode="native_only")
        if not select_ok:
            select_ok = select_ele.select.by_value("opt2", mode="compat")

        page.wait(0.5)
        print("   ✓ 表单填写完成")

        # 5. 提交表单
        print("2. 提交表单...")
        page.ele("#submit-btn").click_self()
        page.wait(1)

        # 6. 验证提交结果
        result = page.ele("#form-result").text
        print(f"   提交结果: {result[:100]}...")

        print("\n场景2: 数据提取")
        print("-" * 40)

        # 7. 提取表格数据
        print("1. 提取表格数据...")
        table_rows = page.eles("#data-table tbody tr")
        print(f"   表格共有 {len(table_rows)} 行数据")

        table_data = []
        for row in table_rows:
            cells = row.eles("tag:td")
            if len(cells) >= 4:
                row_data = {
                    "id": cells[0].text,
                    "name": cells[1].text,
                    "age": cells[2].text,
                    "city": cells[3].text,
                }
                table_data.append(row_data)
                print(f"   - {row_data}")

        print("\n场景3: 动态交互")
        print("-" * 40)

        # 8. 测试动态内容
        print("1. 触发延迟显示...")
        page.ele("text:显示延迟内容").click_self()
        dynamic_elem = page.wait.ele_displayed("#dynamic-content", timeout=5)
        if dynamic_elem:
            print(f"   ✓ 延迟内容已显示: {dynamic_elem.text}")

        # 9. 添加多个内容
        print("2. 添加多个动态内容...")
        for i in range(3):
            page.ele("text:添加内容").click_self()
            page.wait(0.3)

        new_items = page.eles("#content-container .result")
        print(f"   ✓ 已添加 {len(new_items)} 个新内容")

        print("\n场景4: 页面截图")
        print("-" * 40)

        # 10. 截取关键区域
        print("1. 截取关键区域...")
        output_dir = BASE_DIR / "output" / "comprehensive"
        output_dir.mkdir(parents=True, exist_ok=True)

        # 表单区域截图
        try:
            form_section = page.ele("#form-section")
            page.scroll.to_see(form_section)
            page.wait(0.5)
            form_section.screenshot(str(output_dir / "form_filled.png"))
            print(f"   ✓ 表单截图已保存")
        except Exception as e:
            print(f"   ⚠ 表单截图跳过: {str(e)[:50]}")

        # 表格截图
        try:
            table = page.ele("#data-table")
            page.scroll.to_see(table)
            page.wait(0.5)
            table.screenshot(str(output_dir / "table_data.png"))
            print(f"   ✓ 表格截图已保存")
        except Exception as e:
            print(f"   ⚠ 表格截图跳过: {str(e)[:50]}")

        # 整页截图
        page.screenshot(str(output_dir / "full_page.png"))
        print(f"   ✓ 整页截图已保存")

        print("\n场景5: 多次交互")
        print("-" * 40)

        # 11. 连续点击测试
        print("1. 连续点击按钮...")
        click_btn = page.ele("#click-btn")
        for i in range(5):
            click_btn.click_self()
            page.wait(0.2)

        result = page.ele("#click-result").text
        print(f"   点击结果: {result}")

        # 12. 鼠标悬停测试
        print("2. 鼠标悬停测试...")
        hover_target = page.ele("#hover-target")
        hover_target.hover()
        page.wait(0.5)
        hover_result = page.ele("#hover-result").text
        print(f"   悬停结果: {hover_result}")

        # 12.1 isTrusted 行为验证
        print("3. isTrusted 行为验证...")
        page.ele("#click-btn").click_self()
        page.wait(0.2)
        page.ele("#text-input").input("T", clear=False)
        page.wait(0.2)
        hover_target.hover()
        page.wait(0.2)
        print(f"   click isTrusted: {page.is_trusted('click')}")
        print(f"   keydown isTrusted: {page.is_trusted('keydown')}")
        print(f"   mouseenter isTrusted: {page.is_trusted('mouseenter')}")

        print("\n场景6: 数据验证")
        print("-" * 40)

        # 13. 验证元素状态
        print("1. 验证元素状态...")
        disabled_btn = page.ele("#disabled-btn")
        print(f"   禁用按钮是否可用: {disabled_btn.is_enabled}")
        print(f"   禁用按钮是否显示: {disabled_btn.is_displayed}")

        # 14. 验证输入值
        print("2. 验证输入值...")
        text_value = page.ele("#text-input").value
        email_value = page.ele("#email-input").value
        print(f"   文本输入框: {text_value}")
        print(f"   邮箱输入框: {email_value}")

        # 15. 验证选择状态
        print("3. 验证选择状态...")
        checkbox1_checked = page.ele("#checkbox1").is_checked
        radio1_checked = page.ele("#radio1").is_checked
        print(f"   复选框1选中: {checkbox1_checked}")
        print(f"   单选框1选中: {radio1_checked}")

        print("\n" + "=" * 60)
        print("✓ 综合测试全部通过！")
        print(f"截图保存在: {output_dir}")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        page.wait(3)
        page.quit()


if __name__ == "__main__":
    test_comprehensive()
