# -*- coding: utf-8 -*-
"""示例44: 使用指定 user_dir 打开 Shopee 搜索页并采集 3 页商品文本。"""

import io
import sys


if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


from ruyipage import launch


TARGET_URL = "https://shopee.tw/search?keyword=iphone%E6%89%8B%E9%8C%B6"
USER_DIR = r"F:\ruyipage\user1"
ITEMS_XPATH = "xpath://section[1]/ul[1]/li"
NEXT_PAGE_XPATH = "xpath:/html[1]/body[1]/div[1]/div[1]/div[2]/div[1]/div[1]/div[1]/div[1]/div[1]/div[2]/section[1]/div[1]/nav[1]/a[5]"
PAGE_COUNT = 3


def collect_page_items(page, page_no):
    print(f"第 {page_no} 页先滚动到底部...")
    page.scroll.to_bottom()
    page.wait(5)

    page.wait.ele(ITEMS_XPATH, timeout=20)
    page.wait(2)

    items = page.eles(ITEMS_XPATH, timeout=2)
    rows = []
    for index, item in enumerate(items, 1):
        text = (item.text or "").strip()
        rows.append({"page": page_no, "index": index, "text": text})
    return rows


def goto_next_page(page, current_page):
    next_btn = page.ele(NEXT_PAGE_XPATH, timeout=5)
    if not next_btn:
        raise RuntimeError(f"第 {current_page} 页未找到下一页按钮: {NEXT_PAGE_XPATH}")

    print(f"第 {current_page} 页采集完成，点击下一页...")
    next_btn.click_self()
    page.wait.doc_loaded(timeout=20)
    page.wait(3)


def main():
    page = launch(
        headless=False,
        user_dir=USER_DIR,
        xpath_picker=True,
        window_size=(1600, 1100),
    )

    try:
        page.get(TARGET_URL)
        page.wait.doc_loaded(timeout=20)
        page.wait(5)

        print("=" * 72)
        print("示例44: Shopee 搜索页 + user_dir + XPath picker + 3 页采集")
        print("页面地址:", page.url)
        print("标题:", page.title)
        print("user_dir:", USER_DIR)
        print("XPath picker: 已启用")
        print("采集 XPath:", ITEMS_XPATH)
        print("翻页 XPath:", NEXT_PAGE_XPATH)
        print("=" * 72)

        all_rows = []
        for page_no in range(1, PAGE_COUNT + 1):
            rows = collect_page_items(page, page_no)
            all_rows.extend(rows)

            print(f"\n[第 {page_no} 页] 共采集 {len(rows)} 项")
            for row in rows:
                text = row["text"] or "<空>"
                print(f"  {row['index']:02d}. {text}")

            if page_no < PAGE_COUNT:
                goto_next_page(page, page_no)

        print(f"\n总计采集 {len(all_rows)} 项，来自 {PAGE_COUNT} 页。")

    finally:
        page.wait(1000)
        page.quit()


if __name__ == "__main__":
    main()
