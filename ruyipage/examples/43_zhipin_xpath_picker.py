# -*- coding: utf-8 -*-
"""示例43: Boss 直聘杭州页按坐标搜索并打印 joblist.json 原始响应。"""

import os
import sys


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ruyipage import Keys, launch


TARGET_URL = "https://www.zhipin.com/hangzhou"
KEYWORD = "爬虫工程师"
SEARCH_COORD = {"x": 856, "y": 100}
JOBLIST_API = "https://www.zhipin.com/wapi/zpgeek/search/joblist.json"


def xy_click_type_enter(page, keyword):
    print(f"按坐标点击搜索框: ({SEARCH_COORD['x']}, {SEARCH_COORD['y']})")
    page.actions.move_to(SEARCH_COORD).click().perform()
    page.wait(0.3)

    page.actions.combo(Keys.CTRL, "a").perform()
    page.wait(0.05)
    page.actions.press(Keys.DELETE).perform()
    page.wait(0.1)

    page.actions.type(keyword, interval=80).press(Keys.ENTER).perform()
    print("已输入并回车，等待页面 3 秒...")
    page.wait(3)


def decode_network_text(data):
    if not data or not data.has_data:
        return None
    raw = data.bytes
    if raw is None:
        return None
    if isinstance(raw, bytes):
        return raw.decode("utf-8", errors="replace")
    if isinstance(raw, str):
        return raw
    return str(raw)


def main():
    page = launch(
        headless=False,
        xpath_picker=True,
        window_size=(1600, 1100),
    )
    collector = None
    try:
        page.get(TARGET_URL)
        page.wait.doc_loaded(timeout=15)

        print("=" * 72)
        print("示例43: Boss 直聘杭州页按坐标搜索并打印 joblist.json")
        print("页面地址:", TARGET_URL)
        print("搜索关键词:", KEYWORD)
        print("目标接口:", JOBLIST_API)
        print("=" * 72)
        #page.wait(100)

        collector = page.network.add_data_collector(
            ["responseCompleted"],
            data_types=["response"],
        )
        page.listen.start(JOBLIST_API, method="POST")

        xy_click_type_enter(page, KEYWORD)

        while 1:
            packet = page.listen.wait(timeout=30)
            if not packet:
                raise RuntimeError("未捕获到 joblist.json 响应")

            request_id = packet.request.get("request", "") if packet.request else ""
            if not request_id:
                raise RuntimeError("已捕获 joblist.json 响应，但缺少 request_id")

            body = decode_network_text(collector.get(request_id, data_type="response"))
            if not body:
                raise RuntimeError("已捕获 joblist.json，但未取到响应体")

            print(f"已捕获响应: {packet.status} {packet.url}")
            print(body)
            if '您的环境存在异常' in body:
                continue
            else:
                break
    finally:
        try:
            page.listen.stop()
        except Exception:
            pass
        if collector:
            try:
                collector.remove()
            except Exception:
                pass
        
        page.wait(3)
        page.quit()


if __name__ == "__main__":
    main()
