# -*- coding: utf-8 -*-
"""示例21-Mobile: 移动端模拟访问 Google

目标：
1) 使用 RuyiPage 的移动端模拟接口
2) 访问 Google 首页
3) 验证 UA / 视口 / 页面标题

说明：
- 当前 Firefox 对 emulation.setTouchOverride 未实现，因此触摸支持可能显示为 False。
- 本示例重点验证“移动端参数模拟 + 页面访问”整体链路。
"""

import io
import sys


if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


from ruyipage import FirefoxOptions, FirefoxPage


def test_mobile_google_emulation():
    print("=" * 70)
    print("测试: 移动端模拟访问 Google")
    print("=" * 70)

    opts = FirefoxOptions()
    opts.headless(False)
    page = FirefoxPage(opts)

    try:
        iphone_ua = (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
            "Mobile/15E148 Safari/604.1"
        )

        print("\n1. 应用移动端模拟参数...")
        support = page.emulation.apply_mobile_preset(
            iphone_ua,
            width=390,
            height=844,
            device_pixel_ratio=3.0,
            orientation_type="portrait-primary",
            angle=0,
            locale="en-US",
            timezone_id="America/Los_Angeles",
            touch=False,
        )
        print(f"   基础支持情况: {support}")

        touch_results = {}
        for scope in ("context", "global", "user_context"):
            try:
                ok = page.emulation.set_touch_enabled(
                    True, max_touch_points=5, scope=scope
                )
            except Exception as e:
                ok = False
                print(f"   触摸作用域 {scope} 异常: {e}")
            page.refresh()
            touch_points = page.run_js("navigator.maxTouchPoints || 0")
            touch_results[scope] = {"supported": ok, "maxTouchPoints": touch_points}
        print(f"   触摸作用域结果: {touch_results}")

        print("\n2. 打开 Google 首页...")
        page.get("https://www.google.com/ncr")
        page.wait(2)

        print("\n3. 读取移动端环境信息...")
        ua = page.run_js("navigator.userAgent")
        width = page.run_js("window.innerWidth")
        height = page.run_js("window.innerHeight")
        dpr = page.run_js("window.devicePixelRatio")
        language = page.run_js("navigator.language")
        touch_points = page.run_js("navigator.maxTouchPoints || 0")
        title = page.title

        print(f"   页面标题: {title}")
        print(f"   UA: {ua}")
        print(f"   视口: {width}x{height}")
        print(f"   DPR: {dpr}")
        print(f"   语言: {language}")
        print(f"   maxTouchPoints: {touch_points}")

        ua_ok = "iPhone" in str(ua)
        viewport_ok = int(width) <= 500
        title_ok = "Google" in str(title)

        print("\n4. 结果判断...")
        print(f"   UA 命中移动端: {ua_ok}")
        print(f"   视口为移动端宽度: {viewport_ok}")
        print(f"   Google 页面打开成功: {title_ok}")

        if not (ua_ok and viewport_ok and title_ok):
            raise RuntimeError("移动端模拟访问 Google 的关键检查未全部通过")

        print("\n" + "=" * 70)
        print("✓ 移动端模拟访问 Google 测试通过")
        print("=" * 70)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        page.wait(1)
        page.quit()


if __name__ == "__main__":
    test_mobile_google_emulation()
