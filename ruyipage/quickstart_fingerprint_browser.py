from ruyipage import FirefoxPage,FirefoxOptions


def test_emulation():
    opts = FirefoxOptions()
    #请使用https://github.com/LoseNine/firefox-fingerprintBrowser，或者任意抹除webdriver的指纹浏览器
    opts.set_browser_path(r"C:\Program Files\Mozilla Firefox\firefox.exe")
    opts.set_fpfile(r"C:\Program Files\Mozilla Firefox\profile1.txt")
    page = FirefoxPage(opts)
    page.get("https://www.browserscan.net/zh")

    #地理位置模拟
    page.emulation.set_geolocation(39.9042, 116.4074, accuracy=100)

    #时区模拟
    page.emulation.set_timezone("Asia/Tokyo")

    #语言模拟
    page.emulation.set_locale(['ja-JP', 'ja'])
    page.network.set_extra_headers({
        "Accept-Language": "ja-JP,ja;q=0.9"
    })

    #屏幕模拟
    page.emulation.set_screen_size(1366, 768, device_pixel_ratio=2.0)
    page.refresh()

    sw = page.run_js("screen.width")
    sh = page.run_js("screen.height")
    print(f"屏幕设置覆盖,当前={sw}x{sh}")


if __name__ == "__main__":
    test_emulation()
