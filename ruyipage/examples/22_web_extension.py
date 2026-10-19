#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""示例22: WebExtension 模块测试（完整链路版）

完整链路：
1) 创建测试扩展
2) 安装目录扩展
3) 验证扩展已安装
4) 卸载目录扩展
5) 打包 xpi 并安装
6) 验证扩展已安装
7) 卸载打包扩展
8) 清理测试文件

说明：
- WebExtension BiDi 规范只提供 install / uninstall 命令。
- 当前 Firefox 环境下若返回 unknown command，则视为“当前版本不支持”，不是脚本错误。
"""

import io
import json
import os
import shutil
import sys
import zipfile

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

from ruyipage import FirefoxPage


class Rows:
    def __init__(self):
        self.rows = []

    def add(self, name, status, detail=""):
        self.rows.append((name, status, detail))
        print(f"  {status}: {name}")
        if detail:
            print(f"     详情: {detail}")

    def summary(self):
        print("\n" + "=" * 70)
        print("测试结果汇总")
        print("=" * 70)
        print(f"{'序号':<5} {'项目':<28} {'状态':<8} {'说明'}")
        print("-" * 70)
        for i, (name, status, detail) in enumerate(self.rows, 1):
            print(f"{i:<5} {name:<28} {status:<8} {detail[:36]}")
        print("-" * 70)


def _create_test_extension(ext_dir):
    os.makedirs(ext_dir, exist_ok=True)
    manifest = {
        "manifest_version": 2,
        "name": "RuyiPage Test Extension",
        "version": "1.0.0",
        "description": "测试扩展",
        "browser_specific_settings": {
            "gecko": {
                "id": "test@ruyipage.com",
                "strict_min_version": "109.0",
            }
        },
        "background": {"scripts": ["background.js"]},
        "content_scripts": [
            {
                "matches": ["<all_urls>"],
                "js": ["content.js"],
                "run_at": "document_end",
            }
        ],
        "permissions": [],
    }
    with open(os.path.join(ext_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)

    with open(os.path.join(ext_dir, "background.js"), "w", encoding="utf-8") as f:
        f.write("console.log('RuyiPage Test Extension loaded!');")

    with open(os.path.join(ext_dir, "content.js"), "w", encoding="utf-8") as f:
        f.write(
            "document.documentElement.setAttribute('data-ruyi-extension', 'loaded');"
        )


def _page_has_extension_marker(page):
    return (
        page.run_js(
            "return document.documentElement.getAttribute('data-ruyi-extension')"
        )
        == "loaded"
    )


def _safe_install(page, path, rows, label):
    try:
        ext_id = page.extensions.install(path)
        if ext_id:
            rows.add(label, "✓ 通过", f"extension_id={ext_id}")
            return ext_id
        rows.add(label, "⚠ 不支持", "当前 Firefox 未返回 extension id")
        return None
    except Exception as e:
        msg = str(e).lower()
        if "unknown command" in msg or "not supported" in msg:
            rows.add(label, "⚠ 不支持", "当前 Firefox 不支持 webExtension.install")
            return None
        raise


def test_web_extension():
    print("=" * 70)
    print("测试 22: WebExtension 模块")
    print("=" * 70)

    page = FirefoxPage()
    rows = Rows()
    ext_dir = "E:/ruyipage/examples/test_extension"
    xpi_path = "E:/ruyipage/examples/test_extension.xpi"

    ext_id = None
    ext_id2 = None

    try:
        # 1) 创建测试扩展
        _create_test_extension(ext_dir)
        rows.add("创建测试扩展", "✓ 通过", ext_dir)

        # 2) 安装目录扩展
        ext_id = _safe_install(page, ext_dir, rows, "安装目录扩展")

        # 3) 验证目录扩展已生效
        if ext_id:
            page.get("https://example.com")
            page.wait(1.5)
            marker = _page_has_extension_marker(page)
            rows.add(
                "目录扩展生效验证",
                "✓ 通过" if marker else "✗ 失败",
                "content script 已注入" if marker else "未检测到注入标记",
            )
        else:
            rows.add("目录扩展生效验证", "⚠ 跳过", "安装未成功")

        # 4) 卸载目录扩展
        if ext_id:
            page.extensions.uninstall(ext_id)
            rows.add("卸载目录扩展", "✓ 通过")
        else:
            rows.add("卸载目录扩展", "⚠ 跳过", "未安装成功")

        # 5) 打包 xpi
        with zipfile.ZipFile(xpi_path, "w", zipfile.ZIP_DEFLATED) as zipf:
            zipf.write(os.path.join(ext_dir, "manifest.json"), "manifest.json")
            zipf.write(os.path.join(ext_dir, "background.js"), "background.js")
            zipf.write(os.path.join(ext_dir, "content.js"), "content.js")
        rows.add("打包 XPI", "✓ 通过", xpi_path)

        # 6) 安装打包扩展
        try:
            ext_id2 = page.extensions.install_archive(xpi_path)
            if ext_id2:
                rows.add("安装 XPI 扩展", "✓ 通过", f"extension_id={ext_id2}")
            else:
                rows.add(
                    "安装 XPI 扩展", "⚠ 不支持", "当前 Firefox 未返回 extension id"
                )
        except Exception as e:
            msg = str(e).lower()
            if "unknown command" in msg or "not supported" in msg:
                rows.add(
                    "安装 XPI 扩展",
                    "⚠ 不支持",
                    "当前 Firefox 不支持 webExtension.install",
                )
            else:
                raise

        # 7) 验证 XPI 扩展已生效
        if ext_id2:
            page.get("https://example.com")
            page.wait(1.5)
            marker = _page_has_extension_marker(page)
            rows.add(
                "XPI 扩展生效验证",
                "✓ 通过" if marker else "✗ 失败",
                "content script 已注入" if marker else "未检测到注入标记",
            )
        else:
            rows.add("XPI 扩展生效验证", "⚠ 跳过", "安装未成功")

        # 8) 卸载打包扩展
        if ext_id2:
            page.extensions.uninstall(ext_id2)
            rows.add("卸载 XPI 扩展", "✓ 通过")
        else:
            rows.add("卸载 XPI 扩展", "⚠ 跳过", "未安装成功")

        print("\n" + "=" * 70)
        print("✓ WebExtension 模块测试完成")
        print("=" * 70)

    except Exception as e:
        rows.add("WebExtension 模块", "✗ 失败", str(e))
        import traceback

        traceback.print_exc()
    finally:
        try:
            page.extensions.uninstall_all()
        except Exception:
            pass
        page.quit()

        if os.path.exists(ext_dir):
            shutil.rmtree(ext_dir)
        if os.path.exists(xpi_path):
            os.remove(xpi_path)

        rows.add("清理测试文件", "✓ 通过")
        rows.summary()


if __name__ == "__main__":
    test_web_extension()
