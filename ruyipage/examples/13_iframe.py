# -*- coding: utf-8 -*-
"""示例13: iframe 操作（完整 + 复杂场景）

覆盖点：
1) 通过 locator/index/context_id 三种方式访问 iframe
2) 在 iframe 内元素查找、点击、JS 执行
3) 读取 iframe 列表和跨上下文稳定性
4) 使用 with_frame() 简化接口（新手友好）
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


def test_iframe():
    """测试iframe操作功能"""
    print("=" * 60)
    print("测试13: iframe操作")
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

        # 滚动到iframe区域
        page.scroll.to_see(page.ele("#iframe-section"))
        page.wait(0.5)

        # 1. 获取iframe元素
        print("\n1. 获取iframe元素:")
        iframe_elem = page.ele("#test-iframe")
        print(f"   ✓ iframe元素已找到: {iframe_elem.tag}")

        # 1.1 获取所有 frame
        print("\n1.1 获取所有iframe:")
        frames = page.get_frames()
        print(f"   当前页面 frame 数量: {len(frames)}")

        # 2. 切换到iframe
        print("\n2. 切换到iframe:")
        iframe = page.get_frame("#test-iframe")
        print(f"   ✓ 已切换到iframe")

        # 2.1 通过 index 获取
        print("\n2.1 通过 index 获取iframe:")
        iframe_by_index = page.get_frame(index=0)
        print(f"   index=0 是否可用: {iframe_by_index is not None}")

        # 2.2 通过 context_id 获取
        print("\n2.2 通过 context_id 获取iframe:")
        iframe_by_ctx = page.get_frame(context_id=iframe.tab_id)
        print(f"   context_id 是否匹配: {iframe_by_ctx.tab_id == iframe.tab_id}")

        # 3. 在iframe中查找元素
        print("\n3. 在iframe中查找元素:")
        iframe_title = iframe.ele("tag:h1")
        if iframe_title:
            print(f"   iframe标题: {iframe_title.text}")
        else:
            print(f"   未找到iframe标题")

        # 3.1 iframe跨域判断
        print("\n3.1 iframe跨域判断:")
        print(f"   is_cross_origin: {iframe.is_cross_origin}")

        # 4. 在iframe中操作按钮
        print("\n4. 在iframe中操作按钮:")
        iframe_btn = iframe.ele("#iframe-btn")
        if iframe_btn:
            print(f"   找到iframe按钮: {iframe_btn.text}")
            iframe_btn.click_self()
            page.wait(1)
            print(f"   ✓ iframe按钮已点击")
        else:
            print(f"   未找到iframe按钮")

        # 5. 获取iframe内容
        print("\n5. 获取iframe内容:")
        iframe_html = iframe.html
        print(f"   iframe HTML长度: {len(iframe_html)} 字符")

        # 6. 在iframe中执行JS
        print("\n6. 在iframe中执行JS:")
        result = iframe.run_js("return document.body.innerHTML")
        print(f"   iframe body内容长度: {len(result)} 字符")

        # 6.1 iframe 内脚本修改 DOM
        print("\n6.1 iframe 内修改DOM并验证:")
        iframe.run_js(
            """
            const h = document.querySelector('h1');
            h.textContent = 'iframe内容-已修改';
            return h.textContent;
            """,
            as_expr=False,
        )
        changed_title = iframe.ele("tag:h1").text
        print(f"   修改后标题: {changed_title}")

        # 7. 切换回主页面
        print("\n7. 切换回主页面:")
        # 直接使用page对象即可，它始终指向主页面
        main_title = page.ele("#main-title")
        print(f"   主页面标题: {main_title.text}")

        # 7.1 验证主页面元素仍可操作
        click_btn = page.ele("#click-btn")
        click_btn.click_self()
        page.wait(0.4)
        click_result = page.ele("#click-result").text
        print(f"   主页面点击结果: {click_result}")

        # 8. 再次切换到iframe
        print("\n8. 再次切换到iframe:")
        iframe2 = page.get_frame("#test-iframe")
        iframe_title2 = iframe2.ele("tag:h1")
        if iframe_title2:
            print(f"   ✓ 再次访问iframe成功: {iframe_title2.text}")

        # 8.1 使用 with_frame 简化接口
        print("\n8.1 使用 with_frame() 访问iframe:")
        with page.with_frame("#test-iframe") as frame_ctx:
            frame_text = frame_ctx.ele("tag:h1").text
            print(f"   with_frame 读取标题: {frame_text}")

        # 8.2 with_frame 结束后仍在主页面上下文
        still_main = page.ele("#main-title").text
        print(f"   with_frame 退出后主页面标题: {still_main}")

        print("\n" + "=" * 60)
        print("✓ 所有iframe操作测试通过！")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        page.wait(2)
        page.quit()


if __name__ == "__main__":
    test_iframe()
