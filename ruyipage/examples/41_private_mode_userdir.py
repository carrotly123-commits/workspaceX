# -*- coding: utf-8 -*-
"""示例41: 使用 private 模式和指定 user_dir 启动 Firefox。"""

import io
import sys


if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


from ruyipage import FirefoxOptions, FirefoxPage, launch


TARGET_URL = "https://www.example.com"
USER_DIR = r"D:\ruyipage_userdir"


def example_with_options():
    print("=" * 60)
    print("示例41: private 模式 + user_dir")
    print("=" * 60)

    opts = FirefoxOptions()

    # set_user_dir() 和 set_profile() 作用相同，都是指定 Firefox profile 目录。
    # 对大多数使用者来说，set_user_dir() 更直观。
    opts.set_user_dir(USER_DIR)
    # opts.set_profile(USER_DIR)

    # private_mode(True) 和 launch(private=True) 作用相同，
    # 都会在 Firefox 启动命令中加入 -private。
    opts.private_mode(True)

    page = FirefoxPage(opts)

    try:
        page.get(TARGET_URL)
        print("标题:", page.title)
        print("地址:", page.url)
        print("当前 user_dir:", USER_DIR)
        print("private 模式: 已启用")
    finally:
        page.quit()


def example_with_launch():
    # 这里的 user_dir=... 和 opts.set_user_dir(...) 作用相同。
    # 这里的 private=True 和 opts.private_mode(True) 作用相同。
    page = launch(
        headless=False,
        user_dir=USER_DIR,
        private=True,
    )

    try:
        page.get(TARGET_URL)
        print("[launch] 标题:", page.title)
        print("[launch] 地址:", page.url)
    finally:
        page.quit()


if __name__ == "__main__":
    # 默认演示 FirefoxOptions 写法。
    # 如果你更喜欢 launch()，可改为运行 example_with_launch()。
    example_with_options()
    # example_with_launch()
