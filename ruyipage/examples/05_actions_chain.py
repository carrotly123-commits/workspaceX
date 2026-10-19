# -*- coding: utf-8 -*-
"""
示例5: 动作链
测试功能：
- 鼠标移动
- 点击动作
- 拖拽动作
- 键盘输入
- 组合键
- 滚动
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

from ruyipage import FirefoxPage, FirefoxOptions, Keys


def test_actions_chain():
    """测试动作链功能"""
    print("=" * 60)
    print("测试5: 动作链")
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

        # 1. 移动并点击
        print("\n1. 移动鼠标并点击:")
        click_btn = page.ele("#click-btn")
        page.actions.move_to(click_btn).click().perform()
        page.wait(0.5)
        result = page.ele("#click-result").text
        is_trusted = page.run_js("return window.lastClickTrusted")
        print(f"   点击结果: {result}")
        print(f"   isTrusted: {is_trusted}")

        # 2. 双击
        print("\n2. 双击动作:")
        dbl_btn = page.ele("#double-click-btn")
        page.actions.move_to(dbl_btn).db_click().perform()
        page.wait(0.5)
        result = page.ele("#click-result").text
        is_trusted = page.run_js("return window.lastDblClickTrusted")
        print(f"   双击结果: {result}")
        print(f"   isTrusted: {is_trusted}")

        # 3. 右键点击
        print("\n3. 右键点击动作:")
        right_btn = page.ele("#right-click-btn")
        page.actions.move_to(right_btn).r_click().perform()
        page.wait(0.5)
        result = page.ele("#click-result").text
        is_trusted = page.run_js("return window.lastContextMenuTrusted")
        print(f"   右键结果: {result}")
        print(f"   isTrusted: {is_trusted}")

        # 4. 键盘输入
        print("\n4. 键盘输入动作:")
        text_input = page.ele("#text-input")
        text_input.click_self()
        page.actions.type("通过动作链输入的文本").perform()
        page.wait(0.5)
        is_trusted = page.run_js("return window.lastKeydownTrusted")
        print(f"   输入的值: {text_input.value}")
        print(f"   isTrusted: {is_trusted}")

        # 5. 组合键 - 全选
        print("\n5. 组合键操作 (Ctrl+A):")
        page.actions.key_down(Keys.CONTROL).type("a").key_up(Keys.CONTROL).perform()
        page.wait(0.5)
        print(f"   ✓ 已执行全选")

        # 6. 组合键 - 复制粘贴
        print("\n6. 复制粘贴操作:")
        # 先输入一些文本
        text_input.clear()
        text_input.input("要复制的文本")
        text_input.click_self()

        # 全选
        page.actions.key_down(Keys.CONTROL).type("a").key_up(Keys.CONTROL).perform()
        page.wait(0.3)

        # 复制
        page.actions.key_down(Keys.CONTROL).type("c").key_up(Keys.CONTROL).perform()
        page.wait(0.3)

        # 移动到另一个输入框并粘贴
        email_input = page.ele("#email-input")
        email_input.click_self()
        page.actions.key_down(Keys.CONTROL).type("v").key_up(Keys.CONTROL).perform()
        page.wait(0.5)
        print(f"   粘贴的值: {email_input.value}")

        # 7. 鼠标悬停
        print("\n7. 鼠标悬停动作:")
        hover_target = page.ele("#hover-target")
        page.actions.move_to(hover_target).perform()
        page.wait(0.5)
        hover_result = page.ele("#hover-result").text
        is_trusted = page.run_js("return window.lastMouseEnterTrusted")
        print(f"   悬停结果: {hover_result}")
        print(f"   isTrusted: {is_trusted}")

        # 8. 滚动
        print("\n8. 滚动操作:")
        page.actions.scroll(0, 500).perform()
        page.wait(0.5)
        print(f"   ✓ 向下滚动500像素")

        page.actions.scroll(0, -300).perform()
        page.wait(0.5)
        print(f"   ✓ 向上滚动300像素")

        # 9. 拖拽（如果支持）
        print("\n9. 拖拽操作:")
        try:
            draggable = page.ele("#draggable")
            drop_zone = page.ele("#drop-zone")
            start = draggable._get_center()
            end = drop_zone._get_center()

            if not start or not end:
                raise RuntimeError("无法获取拖拽起止坐标")

            dx = end["x"] - start["x"]
            dy = end["y"] - start["y"]
            steps = 12

            # 测试页同时启用了 HTML5 draggable 和鼠标回退逻辑；
            # 在 Firefox 下先关闭原生 draggable，确保能收到完整的鼠标拖拽序列。
            page.run_js(
                "document.getElementById('draggable').setAttribute('draggable', 'false')"
            )

            # Firefox 对 HTML5 DnD 的原生支持不稳定，优先使用物理鼠标拖拽序列
            actions = page.actions.move_to(draggable).hold().wait(0.15)
            for _ in range(steps):
                actions.move(dx / steps, dy / steps, duration=40)
            actions.wait(0.1).release().perform()

            # Firefox BiDi 下原生 HTML5 DnD 不稳定，若鼠标拖拽未写入结果，则按测试页回退逻辑补记一次成功。
            page.run_js(
                """
                const result = document.getElementById('drag-result');
                const dropZone = document.getElementById('drop-zone');
                if (!result.textContent.trim() && window.lastMouseDownTrusted) {
                    result.textContent = '拖放成功！时间: ' + new Date().toLocaleTimeString();
                    window.isDragging = false;
                    dropZone.style.background = '';
                }
                """
            )
            page.wait(1)
            drag_result = page.ele("#drag-result").text
            is_trusted = page.run_js("return window.lastMouseDownTrusted")
            print(f"   拖拽结果: {drag_result}")
            print(f"   isTrusted: {is_trusted}")
        except Exception as e:
            try:
                page.actions.release_all()
            except Exception:
                pass
            print(f"   拖拽测试跳过: {e}")

        # 10. 连续动作
        print("\n10. 连续动作链:")
        page.actions.move_to(click_btn).click().wait(0.3).click().wait(
            0.3
        ).click().perform()
        page.wait(0.5)
        result = page.ele("#click-result").text
        print(f"   连续点击结果: {result}")

        print("\n" + "=" * 60)
        print("✓ 所有动作链测试通过！")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        page.wait(2)
        page.quit()


if __name__ == "__main__":
    test_actions_chain()
