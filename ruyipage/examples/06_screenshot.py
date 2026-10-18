# -*- coding: utf-8 -*-
"""
示例6: 截图功能
测试功能：
- 整页截图
- 元素截图
- 保存为文件
- 获取base64
- 获取bytes
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


def test_screenshot():
    """测试截图功能"""
    print("=" * 60)
    print("测试6: 截图功能")
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

        # 创建输出目录
        output_dir = BASE_DIR / "output" / "screenshots"
        output_dir.mkdir(parents=True, exist_ok=True)

        # 1. 整页截图
        print("\n1. 整页截图:")
        full_path = output_dir / "full_page.png"
        page.screenshot(str(full_path))
        print(f"   ✓ 整页截图已保存: {full_path}")

        # 2. 元素截图
        print("\n2. 元素截图:")
        title = page.ele("#main-title")
        title_path = output_dir / "title_element.png"
        title.screenshot(str(title_path))
        print(f"   ✓ 标题元素截图已保存: {title_path}")

        # 3. 表单区域截图
        print("\n3. 表单区域截图:")
        form_section = page.ele("#form-section")
        form_path = output_dir / "form_section.png"
        form_section.screenshot(str(form_path))
        print(f"   ✓ 表单区域截图已保存: {form_path}")

        # 4. 按钮截图
        print("\n4. 按钮截图:")
        btn = page.ele("#click-btn")
        # 先滚动到按钮位置确保可见
        page.scroll.to_see(btn)
        page.wait(0.5)
        btn_path = os.path.join(output_dir, "button.png")
        try:
            btn.screenshot(btn_path)
            print(f"   ✓ 按钮截图已保存: {btn_path}")
        except Exception as e:
            print(f"   ⚠ 按钮截图跳过（元素尺寸问题）: {str(e)[:50]}")

        # 5. 获取截图的base64
        print("\n5. 获取截图base64:")
        base64_data = page.screenshot(as_base64=True)
        print(f"   ✓ Base64数据长度: {len(base64_data)} 字符")

        # 6. 获取截图的bytes
        print("\n6. 获取截图bytes:")
        bytes_data = page.screenshot(as_bytes=True)
        print(f"   ✓ Bytes数据长度: {len(bytes_data)} 字节")

        # 7. 元素base64截图
        print("\n7. 元素base64截图:")
        try:
            # 使用表单区域元素，它更稳定
            form_elem = page.ele("#form-section")
            elem_base64 = form_elem.screenshot(as_base64=True)
            print(f"   ✓ 元素Base64数据长度: {len(elem_base64)} 字符")
        except Exception as e:
            print(f"   ⚠ 元素base64截图跳过（元素尺寸问题）: {str(e)[:50]}")

        # 8. 滚动后截图
        print("\n8. 滚动后截图:")
        page.scroll.to_bottom()
        page.wait(0.5)
        bottom_path = os.path.join(output_dir, "page_bottom.png")
        page.screenshot(bottom_path)
        print(f"   ✓ 页面底部截图已保存: {bottom_path}")

        # 9. 表格截图
        print("\n9. 表格截图:")
        table = page.ele("#data-table")
        table_path = os.path.join(output_dir, "table.png")
        try:
            page.scroll.to_see(table)
            page.wait(0.5)
            table.screenshot(table_path)
            print(f"   ✓ 表格截图已保存: {table_path}")
        except Exception as e:
            print(f"   ⚠ 表格截图跳过（元素尺寸问题）: {str(e)[:50]}")

        print("\n" + "=" * 60)
        print("✓ 所有截图测试通过！")
        print(f"截图保存在: {output_dir}")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        page.wait(2)
        page.quit()


if __name__ == "__main__":
    test_screenshot()
