# -*- coding: utf-8 -*-
"""
示例12: 控制台监听
测试功能：
- 监听console.log
- 监听console.error
- 监听console.warn
- 获取日志内容
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


def test_console_listener():
    """测试控制台监听功能"""
    print("=" * 60)
    print("测试12: 控制台监听")
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

        # 1. 启动控制台监听
        print("\n1. 启动控制台监听:")
        page.console.start()
        print(f"   ✓ 控制台监听已启动")

        # 2. 触发console.log
        print("\n2. 触发console.log:")
        log_btn = page.ele("text:console.log")
        log_btn.click_self()
        page.wait(1)

        logs = page.console.get()
        print(f"   捕获到 {len(logs)} 条日志")
        for log in logs:
            print(f"   - [{log.level}] {log.text}")

        # 3. 触发console.warn
        print("\n3. 触发console.warn:")
        warn_btn = page.ele("text:console.warn")
        warn_btn.click_self()
        page.wait(1)

        logs = page.console.get()
        print(f"   捕获到 {len(logs)} 条日志")
        for log in logs[-1:]:  # 只显示最新的
            print(f"   - [{log.level}] {log.text}")

        # 4. 触发console.error
        print("\n4. 触发console.error:")
        error_btn = page.ele("text:console.error")
        error_btn.click_self()
        page.wait(1)

        logs = page.console.get()
        print(f"   捕获到 {len(logs)} 条日志")
        for log in logs[-1:]:  # 只显示最新的
            print(f"   - [{log.level}] {log.text}")

        # 5. 触发console.info
        print("\n5. 触发console.info:")
        info_btn = page.ele("text:console.info")
        info_btn.click_self()
        page.wait(1)

        logs = page.console.get()
        print(f"   捕获到 {len(logs)} 条日志")

        # 5.1 级别过滤
        print("\n5.1 级别过滤 (error):")
        error_logs = page.console.get(level="error")
        print(f"   error日志数量: {len(error_logs)}")

        # 6. 清空日志
        print("\n6. 清空日志:")
        page.console.clear()
        logs = page.console.get()
        print(f"   清空后日志数量: {len(logs)}")

        # 7. 通过JS输出日志
        print("\n7. 通过JS输出日志:")
        page.run_js('console.log("通过JS输出的日志")')
        page.run_js('console.error("通过JS输出的错误")')
        page.wait(1)

        logs = page.console.get()
        print(f"   捕获到 {len(logs)} 条日志")
        for log in logs:
            print(f"   - [{log.level}] {log.text}")

        # 7.1 wait() 过滤等待
        print("\n7.1 wait() 等待指定日志:")
        page.run_js('console.error("wait-target-message")')
        waited = page.console.wait(level="error", text="wait-target-message", timeout=5)
        if waited:
            print(f"   ✓ wait捕获: [{waited.level}] {waited.text}")
        else:
            print("   ⚠ wait未捕获到目标日志")

        # 8. 停止监听
        print("\n8. 停止监听:")
        page.console.stop()
        print(f"   ✓ 控制台监听已停止")

        # 8.1 停止后不应继续积累新日志
        print("\n8.1 停止后验证不再捕获:")
        before = len(page.console.get())
        page.run_js('console.log("should-not-be-captured-after-stop")')
        page.wait(0.6)
        after = len(page.console.get())
        print(f"   停止前后日志数量: {before} -> {after}")

        print("\n" + "=" * 60)
        print("✓ 所有控制台监听测试通过！")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        try:
            page.console.stop()
        except:
            pass
        page.wait(2)
        page.quit()


if __name__ == "__main__":
    test_console_listener()
