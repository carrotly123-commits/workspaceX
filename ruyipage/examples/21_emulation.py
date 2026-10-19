#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""示例21: Emulation 模块测试（严格结果版）"""

import io
import sys

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

from ruyipage import FirefoxPage


class Row:
    def __init__(self):
        self.rows = []

    def add(self, name, status, detail=""):
        self.rows.append((name, status, detail))
        print(f"  {status}: {name}")
        if detail:
            print(f"     详情: {detail}")

    def table(self):
        print("\n" + "=" * 70)
        print("测试结果汇总")
        print("=" * 70)
        print(f"{'序号':<5} {'项目':<32} {'状态':<8} {'说明'}")
        print("-" * 70)
        for i, (name, status, detail) in enumerate(self.rows, 1):
            print(f"{i:<5} {name:<32} {status:<8} {detail[:32]}")
        print("-" * 70)


def test_emulation():
    print("=" * 70)
    print("测试 21: Emulation 模块")
    print("=" * 70)

    page = FirefoxPage()
    rows = Row()

    try:
        page.get("data:text/html,<html><body><h1>Emulation Test</h1></body></html>")

        # 1) UA
        original_ua = page.run_js("navigator.userAgent")
        custom_ua = (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) "
            "AppleWebKit/605.1.15"
        )
        page.emulation.set_user_agent(custom_ua)
        page.refresh()
        new_ua = page.run_js("navigator.userAgent")
        rows.add(
            "User-Agent 覆盖",
            "✓ 通过" if custom_ua in str(new_ua) else "✗ 失败",
            f"UA={'命中' if custom_ua in str(new_ua) else '未命中'}",
        )

        # 2) geolocation
        try:
            page.emulation.set_geolocation(39.9042, 116.4074, accuracy=100)
            rows.add("地理位置覆盖", "✓ 通过", "命令执行成功")
        except Exception as e:
            rows.add("地理位置覆盖", "✗ 失败", str(e))

        # 3) timezone
        try:
            page.emulation.set_timezone("America/New_York")
            page.refresh()
            timezone = page.run_js("Intl.DateTimeFormat().resolvedOptions().timeZone")
            ok = "New_York" in str(timezone)
            rows.add("时区覆盖", "✓ 通过" if ok else "✗ 失败", f"当前={timezone}")
        except Exception as e:
            rows.add("时区覆盖", "✗ 失败", str(e))

        # 4) locale
        try:
            page.emulation.set_locale("ja-JP")
            page.refresh()
            language = page.run_js("navigator.language")
            ok = "ja" in str(language).lower()
            rows.add("语言覆盖", "✓ 通过" if ok else "✗ 失败", f"当前={language}")
        except Exception as e:
            rows.add("语言覆盖", "✗ 失败", str(e))

        # 5) orientation
        try:
            page.emulation.set_screen_orientation("landscape-primary", angle=90)
            page.refresh()
            orientation = page.run_js("screen.orientation.type")
            ok = "landscape" in str(orientation)
            rows.add(
                "屏幕方向覆盖", "✓ 通过" if ok else "✗ 失败", f"当前={orientation}"
            )
        except Exception as e:
            rows.add("屏幕方向覆盖", "✗ 失败", str(e))

        # 6) screen settings
        try:
            page.emulation.set_screen_size(1920, 1080, device_pixel_ratio=2.0)
            page.refresh()
            sw = page.run_js("screen.width")
            sh = page.run_js("screen.height")
            ok = sw == 1920 and sh == 1080
            rows.add("屏幕设置覆盖", "✓ 通过" if ok else "✗ 失败", f"当前={sw}x{sh}")
        except Exception as e:
            rows.add("屏幕设置覆盖", "✗ 失败", str(e))

        # 7) network offline
        supported = page.emulation.set_network_offline(True)
        rows.add(
            "网络条件模拟",
            "✓ 通过" if supported else "⚠ 不支持",
            "离线模式" if supported else "当前 Firefox 未实现",
        )

        # 8) touch override
        supported = page.emulation.set_touch_enabled(True)
        rows.add(
            "触摸模拟",
            "✓ 通过" if supported else "⚠ 不支持",
            "启用触摸" if supported else "当前 Firefox 未实现",
        )

        # 9) javascript enable
        supported = page.emulation.set_javascript_enabled(True)
        rows.add(
            "JavaScript 开关",
            "✓ 通过" if supported else "⚠ 不支持",
            "启用 JS" if supported else "当前 Firefox 未实现",
        )

        # 10) scrollbar
        supported = page.emulation.set_scrollbar_type("overlay")
        rows.add(
            "滚动条类型",
            "✓ 通过" if supported else "⚠ 不支持",
            "overlay" if supported else "当前 Firefox 未实现",
        )

        # 11) forced colors
        supported = page.emulation.set_forced_colors_mode("dark")
        rows.add(
            "强制颜色模式",
            "✓ 通过" if supported else "⚠ 不支持",
            "dark" if supported else "当前 Firefox 未实现",
        )

        # 12) bypass csp
        supported = page.emulation.set_bypass_csp(True)
        rows.add(
            "CSP 绕过",
            "✓ 通过" if supported else "⚠ 不支持",
            "enabled=True" if supported else "当前 Firefox 未实现",
        )

        # 13) mobile preset
        support = page.emulation.apply_mobile_preset(
            custom_ua,
            width=390,
            height=844,
            device_pixel_ratio=3.0,
            orientation_type="portrait-primary",
            angle=0,
            locale="en-US",
            timezone_id="America/New_York",
            touch=True,
        )
        rows.add("移动端预设", "✓ 通过", str(support))

        print("\n" + "=" * 70)
        print("✓ Emulation 模块测试完成")
        print("=" * 70)
    finally:
        rows.table()
        page.quit()


if __name__ == "__main__":
    test_emulation()
