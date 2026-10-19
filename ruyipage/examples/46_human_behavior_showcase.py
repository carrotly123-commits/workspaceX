# -*- coding: utf-8 -*-
"""Example 46: Human behavior showcase.

专门演示：
1. Bézier 拟人轨迹
2. WindMouse 拟人轨迹
3. action_visual 可视化轨迹显示

建议直接运行本例，然后观察页面上的轨迹、点击和输入效果。
"""

from pathlib import Path

from ruyipage import FirefoxOptions, FirefoxPage


def main():
    html_path = (
        Path(__file__).resolve().parent
        / "test_pages"
        / "46_human_behavior_showcase.html"
    )

    opts = FirefoxOptions()
    opts.enable_action_visual(True)
    opts.set_human_algorithm("bezier")
    opts.set_window_size(1440, 980)

    page = FirefoxPage(opts)
    page.get(html_path.as_uri())
    page.wait(1)

    # 第一轮：Bezier 轨迹
    page.actions.human_move(page.ele("#target-a"), algorithm="bezier", style="line_then_arc").human_click().perform()
    page.wait(0.6)

    # 第二轮：WindMouse 轨迹
    page.actions.human_move(page.ele("#target-b"), algorithm="windmouse").human_click().perform()
    page.wait(0.6)

    # 第三轮：拟人化输入
    page.actions.human_move(page.ele("#search-input"), algorithm="bezier", style="arc").human_click().human_type("Bezier -> WindMouse demo").perform()
    page.wait(0.6)

    page.actions.human_move(page.ele("#note-area"), algorithm="windmouse").human_click().human_type(
        "This page is designed to visually compare two human cursor algorithms in ruyiPage."
    ).perform()
    page.wait(0.6)

    page.actions.human_move(page.ele("#complete-btn"), algorithm="windmouse").human_click().perform()

    print("Example 46 已运行。请观察页面上的鼠标轨迹和点击动画。")
    print("- 第一段移动: bezier")
    print("- 第二段移动: windmouse")
    print("- 已开启 action_visual 显示轨迹")

    try:
        input("按 Enter 关闭浏览器...\n")
    except EOFError:
        page.wait(2)
    page.quit()


if __name__ == "__main__":
    main()
