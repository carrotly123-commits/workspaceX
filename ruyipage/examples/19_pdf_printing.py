# -*- coding: utf-8 -*-
"""示例19: PDF 打印（完整参数覆盖）"""

import io
import os
import sys
from pathlib import Path


if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


BASE_DIR = Path(__file__).resolve().parent

sys.path.insert(0, str(BASE_DIR.parent))

from ruyipage import FirefoxOptions, FirefoxPage


def _size_of(path):
    return os.path.getsize(path) if os.path.exists(path) else 0


def test_pdf_printing():
    print("=" * 60)
    print("测试19: PDF打印功能")
    print("=" * 60)

    opts = FirefoxOptions()
    opts.headless(False)
    page = FirefoxPage(opts)

    try:
        test_page = BASE_DIR / "test_pages" / "test_page.html"
        test_url = test_page.resolve().as_uri()
        page.get(test_url)
        page.wait(1)

        output_dir = BASE_DIR / "output" / "pdf"
        output_dir.mkdir(parents=True, exist_ok=True)

        # 1) 基本打印
        print("\n1. 基本PDF打印:")
        p1 = output_dir / "basic.pdf"
        page.save_pdf(str(p1))
        print(f"   ✓ 已保存: {p1} ({_size_of(p1)} bytes)")

        # 2) A4 + 背景
        print("\n2. A4 + 背景:")
        p2 = output_dir / "a4_bg.pdf"
        page.save_pdf(
            str(p2),
            page={"width": 21.0, "height": 29.7},
            background=True,
        )
        print(f"   ✓ 已保存: {p2} ({_size_of(p2)} bytes)")

        # 3) 横向 + 缩放 + 页边距
        print("\n3. 横向 + 缩放 + 页边距:")
        p3 = output_dir / "landscape_scaled.pdf"
        page.save_pdf(
            str(p3),
            orientation="landscape",
            scale=0.9,
            margin={
                "top": 1.2,
                "bottom": 1.2,
                "left": 1.0,
                "right": 1.0,
            },
        )
        print(f"   ✓ 已保存: {p3} ({_size_of(p3)} bytes)")

        # 4) 指定页范围 + shrinkToFit
        print("\n4. 指定页范围 + shrinkToFit:")
        p4 = output_dir / "page_ranges_shrink.pdf"
        page.save_pdf(
            str(p4),
            page_ranges=["1-2"],
            shrink_to_fit=True,
        )
        print(f"   ✓ 已保存: {p4} ({_size_of(p4)} bytes)")

        # 5) 获取 bytes/base64
        print("\n5. 获取 bytes / base64:")
        pdf_bytes = page.pdf(page_ranges=["1"])
        pdf_b64 = (
            __import__("base64")
            .b64encode(page.pdf(shrink_to_fit=False))
            .decode("ascii")
        )
        print(f"   bytes长度: {len(pdf_bytes)}")
        print(f"   base64长度: {len(pdf_b64)}")

        if not (len(pdf_bytes) > 100 and len(pdf_b64) > 100):
            raise RuntimeError("PDF 输出长度异常")

        print("\n" + "=" * 60)
        print("✓ 所有PDF打印测试通过！")
        print(f"PDF保存在: {output_dir}")
        print("=" * 60)

    except Exception as e:
        print(f"\n✗ 测试失败: {e}")
        import traceback

        traceback.print_exc()
    finally:
        page.wait(1)
        page.quit()


if __name__ == "__main__":
    test_pdf_printing()
