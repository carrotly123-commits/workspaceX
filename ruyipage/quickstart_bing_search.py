# -*- coding: utf-8 -*-
"""快速开始：Bing 搜索前 3 页。"""
from ruyipage import FirefoxOptions, FirefoxPage, Keys


opts = FirefoxOptions()
# 如果 Firefox 不在默认安装目录，可以取消注释并指定路径。
# opts.set_browser_path(r"D:\Firefox\firefox.exe")

# 如果你想复用登录状态、Cookie、扩展，可以取消注释并指定 userdir。
# opts.set_user_dir(r"D:\ruyipage_userdir")

page = FirefoxPage(opts)

try:
    page.get("https://cn.bing.com/")
    page.ele("#sb_form_q").input("小肩膀教育")
    page.actions.press(Keys.ENTER).perform()
    page.wait(3)

    for page_no in range(1, 4):
        print("=" * 80)
        print(f"第 {page_no} 页")
        print("=" * 80)

        items = page.eles("css:#b_results > li.b_algo")

        for i, item in enumerate(items, 1):
            title_ele = item.ele("css:h2 a")
            if not title_ele:
                continue

            title = " ".join((title_ele.text or "").split())
            url = title_ele.attr("href") or ""

            desc_ele = item.ele("css:.b_caption p")
            content = desc_ele.text if desc_ele else item.text
            content = " ".join((content or "").split())

            print(f"{i}. {title}")
            print(f"   URL: {url}")
            print(f"   内容: {content}")

        if page_no < 3:
            next_btn = page.ele("css:a.sb_pagN")
            if not next_btn:
                break
            next_btn.click_self()
            page.wait(2)
finally:
    page.quit()
