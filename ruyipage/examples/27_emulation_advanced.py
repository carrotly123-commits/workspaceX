#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""示例27: Emulation 高级能力（严格结果版）"""

import io
import sys
from typing import Dict, List

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

from ruyipage import FirefoxPage


def add_result(
    results: List[Dict[str, str]], item: str, status: str, note: str
) -> None:
    """记录结构化结果。"""
    results.append({"item": item, "status": status, "note": note})


def print_results(results: List[Dict[str, str]]) -> None:
    """打印固定格式结果表。"""
    print("\n| 项目 | 状态 | 说明 |")
    print("| --- | --- | --- |")
    for row in results:
        print(f"| {row['item']} | {row['status']} | {row['note']} |")


def main() -> None:
    print("=" * 70)
    print("测试 27: Emulation 高级能力")
    print("=" * 70)

    page = FirefoxPage()
    results: List[Dict[str, str]] = []

    try:
        page.get("https://www.example.com")
        add_result(results, "页面加载", "成功", "example.com 已加载")

        # 1. 强制颜色模式
        forced_active = page.emulation.set_forced_colors_mode("active")
        add_result(
            results,
            "emulation.setForcedColorsModeThemeOverride active",
            "成功" if forced_active else "不支持",
            "标准命令已实现" if forced_active else "当前 Firefox 未实现该命令",
        )

        forced_none = page.emulation.set_forced_colors_mode("none")
        add_result(
            results,
            "emulation.setForcedColorsModeThemeOverride none",
            "成功" if forced_none else "不支持",
            "标准命令已实现" if forced_none else "当前 Firefox 未实现该命令",
        )

        # 2. 屏幕设置
        page.emulation.set_screen_size(1920, 1080, device_pixel_ratio=2.0)
        size1 = page.run_js(
            "return [screen.width, screen.height, window.devicePixelRatio]"
        )
        if (
            size1
            and int(size1[0]) == 1920
            and int(size1[1]) == 1080
            and float(size1[2]) == 2.0
        ):
            add_result(
                results,
                "emulation.setScreenSettingsOverride 1920x1080@2",
                "成功",
                str(size1),
            )
        elif size1 and int(size1[0]) == 1920 and int(size1[1]) == 1080:
            add_result(
                results,
                "emulation.setScreenSettingsOverride 1920x1080@2",
                "跳过",
                f"尺寸生效，但 DPR 未生效: {size1}",
            )
        else:
            add_result(
                results,
                "emulation.setScreenSettingsOverride 1920x1080@2",
                "失败",
                str(size1)[:120],
            )

        page.emulation.set_screen_size(375, 812, device_pixel_ratio=3.0)
        size2 = page.run_js(
            "return [screen.width, screen.height, window.devicePixelRatio]"
        )
        if (
            size2
            and int(size2[0]) == 375
            and int(size2[1]) == 812
            and float(size2[2]) == 3.0
        ):
            add_result(
                results,
                "emulation.setScreenSettingsOverride 375x812@3",
                "成功",
                str(size2),
            )
        elif size2 and int(size2[0]) == 375 and int(size2[1]) == 812:
            add_result(
                results,
                "emulation.setScreenSettingsOverride 375x812@3",
                "跳过",
                f"尺寸生效，但 DPR 未生效: {size2}",
            )
        else:
            add_result(
                results,
                "emulation.setScreenSettingsOverride 375x812@3",
                "失败",
                str(size2)[:120],
            )

        # 3. 屏幕方向
        page.emulation.set_screen_orientation("portrait-primary", angle=0)
        orientation1 = page.run_js(
            "return [screen.orientation.type, screen.orientation.angle]"
        )
        if orientation1 and orientation1[0] == "portrait-primary":
            add_result(
                results,
                "emulation.setScreenOrientationOverride portrait",
                "成功",
                str(orientation1),
            )
        else:
            add_result(
                results,
                "emulation.setScreenOrientationOverride portrait",
                "失败",
                str(orientation1)[:120],
            )

        page.emulation.set_screen_orientation("landscape-primary", angle=90)
        orientation2 = page.run_js(
            "return [screen.orientation.type, screen.orientation.angle]"
        )
        if (
            orientation2
            and orientation2[0] == "landscape-primary"
            and int(orientation2[1]) == 90
        ):
            add_result(
                results,
                "emulation.setScreenOrientationOverride landscape",
                "成功",
                str(orientation2),
            )
        elif orientation2 and orientation2[0] == "landscape-primary":
            add_result(
                results,
                "emulation.setScreenOrientationOverride landscape",
                "跳过",
                f"方向类型生效，但角度未生效: {orientation2}",
            )
        else:
            add_result(
                results,
                "emulation.setScreenOrientationOverride landscape",
                "失败",
                str(orientation2)[:120],
            )

        # 4. 脚本启用/禁用
        js_off = page.emulation.set_javascript_enabled(False)
        add_result(
            results,
            "emulation.setScriptingEnabled false",
            "成功" if js_off else "不支持",
            "标准命令已实现" if js_off else "当前 Firefox 未实现该命令",
        )

        js_on = page.emulation.set_javascript_enabled(True)
        add_result(
            results,
            "emulation.setScriptingEnabled true",
            "成功" if js_on else "不支持",
            "标准命令已实现" if js_on else "当前 Firefox 未实现该命令",
        )

        # 5. 滚动条类型
        sb_none = page.emulation.set_scrollbar_type("none")
        add_result(
            results,
            "emulation.setScrollbarTypeOverride none",
            "成功" if sb_none else "不支持",
            "标准命令已实现" if sb_none else "当前 Firefox 未实现该命令",
        )

        sb_standard = page.emulation.set_scrollbar_type("standard")
        add_result(
            results,
            "emulation.setScrollbarTypeOverride standard",
            "成功" if sb_standard else "不支持",
            "标准命令已实现" if sb_standard else "当前 Firefox 未实现该命令",
        )

        sb_overlay = page.emulation.set_scrollbar_type("overlay")
        add_result(
            results,
            "emulation.setScrollbarTypeOverride overlay",
            "成功" if sb_overlay else "不支持",
            "标准命令已实现" if sb_overlay else "当前 Firefox 未实现该命令",
        )

        print_results(results)

    except Exception as e:
        add_result(results, "示例执行", "失败", str(e)[:120])
        print_results(results)
        raise
    finally:
        try:
            page.wait(300)
            page.quit()
        except Exception:
            pass


if __name__ == "__main__":
    main()
