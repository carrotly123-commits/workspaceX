# -*- coding: utf-8 -*-
"""
示例2: 元素查找
测试功能：
- CSS选择器查找
- XPath查找
- 文本查找
- 属性查找
- 多元素查找
- 元素属性获取
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


def test_element_finding():
    """测试元素查找功能"""
    print("=" * 60)
    print("测试2: 元素查找")
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

        # 1. 通过ID查找
        print("\n1. 通过ID查找元素:")
        title = page.ele("#main-title")
        print(f"   标题文本: {title.text}")
        print(f"   标签名: {title.tag}")

        # 2. 通过class查找
        print("\n2. 通过class查找元素:")
        test_div = page.ele(".test-class")
        print(f"   第一个.test-class元素: {test_div.text}")

        # 3. 查找所有匹配元素
        print("\n3. 查找所有.test-class元素:")
        all_test = page.eles(".test-class")
        print(f"   找到 {len(all_test)} 个元素")
        for i, elem in enumerate(all_test, 1):
            print(f"   元素{i}: {elem.text}")

        # 4. 通过XPath查找
        print("\n4. 通过XPath查找:")
        link = page.ele('xpath://a[@id="test-link"]')
        print(f"   链接文本: {link.text}")
        print(f"   链接地址: {link.link}")

        # 5. 通过文本查找
        print("\n5. 通过文本查找:")
        btn = page.ele("text:点击我")
        print(f"   按钮ID: {btn.attr('id')}")

        # 6. 通过属性查找
        print("\n6. 通过属性查找:")
        test_div = page.ele('[data-test="value"]')
        print(f"   data-test属性的元素: {test_div.text}")
        print(f"   所有属性: {test_div.attrs}")

        # 7. 组合选择器
        print("\n7. 组合选择器:")
        section = page.ele("#form-section")
        input_elem = section.ele('input[type="text"]')
        print(f"   表单区域内的文本输入框: {input_elem.attr('placeholder')}")

        # 8. 获取元素属性
        print("\n8. 获取元素属性:")
        img = page.ele("#test-img")
        print(f"   图片alt: {img.attr('alt')}")
        print(f"   图片src: {img.src}")

        # 9. 元素状态检查
        print("\n9. 元素状态检查:")
        disabled_btn = page.ele("#disabled-btn")
        print(f"   禁用按钮是否可用: {disabled_btn.is_enabled}")
        print(f"   禁用按钮是否显示: {disabled_btn.is_displayed}")

        # 10. 元素尺寸和位置
        print("\n10. 元素尺寸和位置:")
        click_btn = page.ele("#click-btn")
        print(f"   按钮尺寸: {click_btn.size}")
        print(f"   按钮位置: {click_btn.location}")

        print("\n" + "=" * 60)
        print("✓ 所有元素查找测试通过！")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        page.wait(2)
        page.quit()


if __name__ == "__main__":
    test_element_finding()
