# -*- coding: utf-8 -*-
"""
示例1: 基础导航和页面操作
测试功能：
- 创建浏览器实例
- 页面导航
- 获取标题、URL
- 前进、后退、刷新
- 页面保存
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


def test_basic_navigation():
    """测试基础导航功能"""
    print("=" * 60)
    print("测试1: 基础导航和页面操作")
    print("=" * 60)

    # 创建浏览器实例
    opts = FirefoxOptions()
    opts.headless(False)  # 显示浏览器窗口
    page = FirefoxPage(opts)

    try:
        # 1. 导航到测试页面
        test_page = BASE_DIR / "test_pages" / "test_page.html"
        test_url = test_page.resolve().as_uri()
        print(f"\n1. 导航到测试页面: {test_url}")
        page.get(test_url)
        print(f"   ✓ 页面加载成功")

        # 2. 获取页面信息
        print(f"\n2. 获取页面信息:")
        print(f"   标题: {page.title}")
        print(f"   URL: {page.url}")
        print(f"   HTML长度: {len(page.html)} 字符")

        # 3. 导航到其他页面
        print(f"\n3. 导航到其他页面:")
        page.get("https://www.example.com")
        print(f"   当前标题: {page.title}")
        print(f"   当前URL: {page.url}")

        # 4. 后退
        print(f"\n4. 后退到上一页:")
        page.back()
        page.wait(1)
        print(f"   当前标题: {page.title}")

        # 5. 前进
        print(f"\n5. 前进到下一页:")
        page.forward()
        page.wait(1)
        print(f"   当前标题: {page.title}")

        # 6. 刷新页面
        print(f"\n6. 刷新页面:")
        page.refresh()
        page.wait(1)
        print(f"   ✓ 页面已刷新")

        # 7. 保存页面
        print(f"\n7. 保存页面:")
        save_dir = BASE_DIR / "output"
        save_dir.mkdir(exist_ok=True)

        # 保存为HTML
        html_path = page.save(path=str(save_dir), name="example_page", as_pdf=False)
        print(f"   HTML已保存: {html_path}")

        # 保存为PDF
        pdf_path = page.save(path=str(save_dir), name="example_page", as_pdf=True)
        print(f"   PDF已保存: {pdf_path}")

        print("\n" + "=" * 60)
        print("✓ 所有基础导航测试通过！")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        # 关闭浏览器
        page.wait(2)
        page.quit()


if __name__ == "__main__":
    test_basic_navigation()
