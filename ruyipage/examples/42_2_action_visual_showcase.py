# -*- coding: utf-8 -*-
"""示例42_2: 鼠标行为可视化 — 演示版

展示 action_visual=True 下更直观的鼠标调试反馈：
- 鼠标轨迹逐点播放
- 点击位置扩散动画
- 目标元素高亮框
- 当前鼠标坐标显示
- JS click / JS input 的鼠标反馈

演示清单：
  1) BiDi 鼠标移动 / 悬停 / 拟人移动
  2) BiDi 左键 / 双击 / 拟人点击
  3) 多种拖拽
  4) 元素 click / hover / drag_to
  5) JS click / JS input 的鼠标反馈

尽量覆盖本地 mouse-only 页面中的鼠标相关项目，
仅去除右键和中键测试，无需外网。
"""

import io
import json
import os
import sys
import time
from pathlib import Path


if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


BASE_DIR = Path(__file__).resolve().parent

sys.path.insert(0, str(BASE_DIR.parent))
sys.path.insert(0, str(BASE_DIR))

from ruyipage import launch


DELAY = 1.2  # 每步之间的观察延迟


def step(page, title):
    """打印标题并短暂等待，方便肉眼观察。"""
    print(f"  >> {title}")
    page.wait(DELAY)


def s_shape_points(start_x, start_y, width=320, height=220, count=26):
    """生成一组近似 S 形的视口坐标点。"""
    points = []
    for i in range(count):
        t = i / max(1, count - 1)
        x = start_x + width * t
        # 用双倍相位的正弦生成上半弧 + 下半弧，形成 S 形
        y = start_y + (height / 2.0) * __import__("math").sin(
            2 * __import__("math").pi * t
        )
        points.append((int(round(x)), int(round(y))))
    return points


def main():
    test_page = BASE_DIR / "test_pages" / "action_visual_mouse_only.html"
    file_url = test_page.resolve().as_uri()

    page = launch(
        action_visual=True,
        headless=False,
        port=9334,
        window_size=(1400, 900),
    )

    try:
        page.get(file_url)
        page.wait(1)

        print("=" * 70)
        print("  ruyiPage — action_visual 演示")
        print("=" * 70)

        print("\n[0] S 形预热演示")
        bidi_s_points = s_shape_points(120, 160, width=360, height=240, count=28)
        first_x, first_y = bidi_s_points[0]
        page.actions.move_to((first_x, first_y)).perform()
        page.wait(0.2)
        for px, py in bidi_s_points[1:]:
            page.actions.move_to((px, py), duration=28).perform()
        step(page, "0.1 BiDi 鼠标画 S 形轨迹")

        js_s_points = s_shape_points(560, 180, width=360, height=240, count=28)
        page.run_js(
            "if(window.__ruyiAV)window.__ruyiAV.moves({})".format(
                json.dumps([[x, y] for x, y in js_s_points])
            ),
            as_expr=True,
        )
        step(page, "0.2 JS 直接驱动画 S 形轨迹")

        hover_target = page.ele("#hover-target")
        drag_box = page.ele("#draggable")
        drop_zone = page.ele("#drop-zone")

        # ─────────────────────────────────────────────────────
        # BiDi Actions: 鼠标移动 / 悬停
        # ─────────────────────────────────────────────────────
        print("\n[A] 鼠标移动轨迹与悬停")

        # 1) move_to: 视口坐标移动
        page.actions.move_to((200, 200)).perform()
        step(page, "1. move_to(200,200)")

        page.actions.move_to((600, 300)).perform()
        step(page, "   move_to(600,300)")

        page.actions.move_to((400, 500)).perform()
        step(page, "   move_to(400,500)")

        # 2) move: 相对偏移移动
        page.actions.move(100, 0).perform()
        step(page, "2. move(+100, 0) 向右")

        page.actions.move(0, -80).perform()
        step(page, "   move(0, -80) 向上")

        page.actions.move(-50, 50).perform()
        step(page, "   move(-50, +50) 左下")

        # 3) move_to(element): 移动到页面悬停区域
        if hover_target:
            page.scroll.to_see(hover_target, center=True)
            page.wait(0.4)
            page.actions.move_to(hover_target).perform()
            step(page, "3. move_to(#hover-target) 进入悬停区")

        # 4) human_move: 拟人贝塞尔曲线移动
        page.actions.human_move((800, 200)).perform()
        step(page, "4. human_move(800,200) 拟人轨迹")

        page.actions.human_move((300, 600)).perform()
        step(page, "   human_move(300,600) 拟人轨迹")

        page.actions.human_move((900, 400)).perform()
        step(page, "   human_move(900,400) 拟人轨迹")

        # 5) 元素 hover: 走元素级悬停
        if hover_target:
            hover_target.hover()
            step(page, "5. hover_target.hover() 元素悬停")

        # ─────────────────────────────────────────────────────
        # BiDi Actions: 鼠标点击
        # ─────────────────────────────────────────────────────
        print("\n[B] 点击位置 + 目标高亮")

        click_btn = page.ele("#click-btn")

        # 6) click: 标准左键点击
        page.actions.click(click_btn).perform()
        step(page, "6. click(btn) 标准左键")

        # 7) double_click: 双击
        dbl_btn = page.ele("#double-click-btn")
        page.actions.double_click(dbl_btn).perform()
        step(page, "7. double_click(btn) 标准双击")

        # 8) human_click: 拟人化左键点击
        page.actions.human_click(click_btn).perform()
        step(page, "8. human_click(btn) 拟人左键")

        # ─────────────────────────────────────────────────────
        # BiDi Actions: 按住/释放/拖拽
        # ─────────────────────────────────────────────────────
        print("\n[C] 拖拽")

        if drag_box and drop_zone:
            page.scroll.to_see(drag_box, center=True)
            page.wait(0.5)

            # 9) hold / move_to / release: 用页面拖拽元素手动拖到目标区
            page.actions.move_to(drag_box).hold().perform()
            page.wait(0.3)
            page.actions.move_to(drop_zone, duration=420).perform()
            page.wait(0.3)
            page.actions.release().perform()
            step(page, "9. move_to(drag_box) → hold → move_to(drop_zone) → release")

            # 10) move_to + move: 先回拖拽源附近，再做相对拖动
            drag_center = drag_box._get_center() or {"x": 0, "y": 0}
            drop_center = drop_zone._get_center() or {"x": 0, "y": 0}
            page.actions.move_to(drag_box).hold().perform()
            page.wait(0.3)
            page.actions.move(
                int(drop_center.get("x", 0)) - int(drag_center.get("x", 0)),
                int(drop_center.get("y", 0)) - int(drag_center.get("y", 0)),
                duration=450,
            ).perform()
            page.wait(0.3)
            page.actions.release().perform()
            step(page, "10. hold → move(dx,dy) → release 相对拖动")

            # 11) drag_to: 标准拖拽
            page.actions.drag_to(drag_box, drop_zone, duration=700).perform()
            step(page, "11. actions.drag_to(box → zone) 标准拖拽")

        # ─────────────────────────────────────────────────────
        # 元素级操作 (Clicker / element)
        # ─────────────────────────────────────────────────────
        print("\n[D] 元素 click / hover / drag 与 JS click")

        # 先滚到按钮区域
        btn_section = page.ele("#button-section")
        if btn_section:
            page.scroll.to_see(btn_section)
            page.wait(0.5)

        click_btn = page.ele("#click-btn")
        if click_btn:
            page.scroll.to_see(click_btn, center=True)
            page.wait(0.4)
            # 12) ele.click.left
            click_btn.click.left()
            step(page, "12. ele.click.left()")

            # 13) 元素偏移点击演示
            center = click_btn._get_center() or {"x": 0, "y": 0}
            page.actions.move_to(
                (int(center.get("x", 0)) - 18, int(center.get("y", 0)))
            ).click().perform()
            step(page, "13. 元素偏移点击（稳定演示版）")

            # 14) ele.click_self
            page.scroll.to_see(click_btn, center=True)
            page.wait(0.4)
            click_btn.click_self()
            step(page, "14. ele.click_self()")

        # 15) ele.double_click (走 Actions 链)
        dbl_btn = page.ele("#double-click-btn")
        if dbl_btn:
            dbl_btn.double_click()
            step(page, "15. ele.double_click()")

        # 16) ele.hover()
        if hover_target:
            page.scroll.to_see(hover_target, center=True)
            page.wait(0.4)
            hover_target.hover()
            step(page, "16. ele.hover()")

        # 17) ele.drag_to()
        if drag_box and drop_zone:
            page.scroll.to_see(drag_box, center=True)
            page.wait(0.4)
            drag_box.drag_to(drop_zone, duration=0.8)
            step(page, "17. drag_box.drag_to(drop_zone)")

        # 18) ele.click.by_js (现在也有可视化)
        js_click_btn = page.ele("#js-click-btn")
        if js_click_btn:
            js_click_btn.click.by_js()
            step(page, "18. js-click-btn.click.by_js() — JS click 也显示反馈")

        # ─────────────────────────────────────────────────────
        # JS 输入只保留鼠标反馈
        # ─────────────────────────────────────────────────────
        print("\n[E] JS 输入的鼠标反馈")

        # 先悬停输入框，再执行 JS 输入
        form_section = page.ele("#form-section")
        if form_section:
            page.scroll.to_see(form_section)
            page.wait(0.5)

        email_input = page.ele("#email-input")
        if email_input:
            page.actions.move_to(email_input).perform()
            step(page, "19. move_to(#email-input) 输入框悬停")
            email_input.input("js-demo@ruyi.dev", by_js=True)
            step(page, "20. ele.input(..., by_js=True) — 仅保留鼠标反馈")

        # ─────────────────────────────────────────────────────
        # 完成
        # ─────────────────────────────────────────────────────
        print("\n" + "=" * 70)
        print("  全部演示完成")
        print("=" * 70)

        print("\n浏览器保持 12 秒后自动关闭...")
        page.wait(12)

    except Exception as e:
        print(f"\n  !! 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        try:
            page.quit()
        except Exception:
            pass


if __name__ == "__main__":
    main()
