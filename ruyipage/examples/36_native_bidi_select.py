# -*- coding: utf-8 -*-
"""
示例36: 原生 BiDi Select 检测（仅原生）

目标：
1) 只测试 native_only（不允许 JS 保底）
2) 输出分步诊断信息，帮助定位焦点/键盘路径问题
"""

import io
import os
import sys
from pathlib import Path


if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


BASE_DIR = Path(__file__).resolve().parent

sys.path.insert(0, str(BASE_DIR.parent))

from ruyipage import FirefoxOptions, FirefoxPage, Keys


def _state(page, select):
    s = page.run_js("return window.nativeBidiSelectState")
    return {
        "value": select.value,
        "selected_option": select.select.selected_option,
        "focused": s.get("focused"),
        "trusted_change": s.get("trustedChange"),
        "change_count": s.get("changeCount"),
        "events": s.get("events", []),
    }


def test_native_bidi_select():
    print("=" * 60)
    print("测试36: 原生 BiDi Select（仅原生）")
    print("=" * 60)

    opts = FirefoxOptions()
    opts.headless(False)
    page = FirefoxPage(opts)

    try:
        test_page = BASE_DIR / "test_pages" / "native_bidi_select_test.html"
        test_url = test_page.resolve().as_uri()
        page.get(test_url)
        page.wait(1)

        select = page.ele("#single-select")

        print("\n1. 初始状态:")
        st = _state(page, select)
        print(f"   value: {st['value']}")
        print(f"   selected_option: {st['selected_option']}")
        print(f"   focused: {st['focused']}")

        print("\n2. 手动焦点探测（原生 click + 一步键盘）:")
        select.click_self()
        page.wait(0.1)
        page.actions.key_down(Keys.DOWN).key_up(Keys.DOWN).perform()
        page.wait(0.1)
        st_probe = _state(page, select)
        print(f"   probe value: {st_probe['value']}")
        print(f"   probe focused: {st_probe['focused']}")
        print(f"   probe changeCount: {st_probe['change_count']}")

        print("\n3. 使用 selector native_only 选择 opt2:")
        ok = select.select.by_value("opt2", mode="native_only")
        page.wait(0.3)
        st = _state(page, select)
        print(f"   native_only结果: {ok}")
        print(f"   value: {st['value']}")
        print(f"   selected_option: {st['selected_option']}")
        print(f"   focused: {st['focused']}")
        print(f"   trustedChange: {st['trusted_change']}")
        print(f"   changeCount: {st['change_count']}")

        print("\n4. 页面事件日志:")
        for line in st["events"]:
            print(f"   {line}")

        if not ok or select.value != "opt2":
            raise RuntimeError("native_only 未成功切换到 opt2")

        print("\n" + "=" * 60)
        print("✓ 原生 BiDi Select 测试通过！")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        page.wait(1)
        page.quit()


if __name__ == "__main__":
    test_native_bidi_select()
