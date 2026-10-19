# -*- coding: utf-8 -*-
"""示例42_3: 对 debug_px.html 做 browsing context 诊断。

说明：
1) 直接打开 examples/test_pages/debug_px.html
2) 自动等待并识别 PX challenge iframe 对应的 child context
3) 尝试 attach 到该 child context，并执行最小 DOM / canvas probe
4) 该示例用于判断“能探测到哪一层”，不是承诺一定拿到真实 XPath

使用方式：
    python examples/42_3_debug_px_context_probe.py
"""

import io
import json
import sys
import time
from pathlib import Path


if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

try:
    sys.stdout.reconfigure(line_buffering=True, write_through=True)
    sys.stderr.reconfigure(line_buffering=True, write_through=True)
except Exception:
    pass


BASE_DIR = Path(__file__).resolve().parent

sys.path.insert(0, str(BASE_DIR.parent))

from ruyipage import launch


PX_HOST_KEYWORDS = (
    "iframe.hsprotect.net",
    "perimeterx",
    "humansecurity",
    "captcha",
)


def flatten_contexts(items, depth=0, result=None):
    if result is None:
        result = []
    for item in items:
        result.append((depth, item))
        flatten_contexts(getattr(item, "children", []) or [], depth + 1, result)
    return result


def print_context_tree(page):
    tree = page.contexts.get_tree(root=page.tab_id)
    flat = flatten_contexts(tree.contexts)

    print("\n[1] browsing context tree")
    for depth, item in flat:
        indent = "  " * depth
        url = item.url or ""
        short_url = url[:120] + ("..." if len(url) > 120 else "")
        print(
            "{}- context={} parent={} children={} url={}".format(
                indent,
                item.context,
                item.parent or "-",
                len(item.children or []),
                short_url or "-",
            )
        )

    return tree


def wait_for_px_iframe(page, timeout=25):
    end = time.time() + timeout
    last_src = ""
    while time.time() < end:
        iframe = page.ele("tag:iframe")
        if iframe:
            last_src = iframe.attr("src") or ""
            if last_src:
                return iframe, last_src
        time.sleep(0.5)
    return None, last_src


def find_px_context(page):
    tree = page.contexts.get_tree(root=page.tab_id)
    flat = flatten_contexts(tree.contexts)
    for _, item in flat:
        url = (item.url or "").lower()
        if any(key in url for key in PX_HOST_KEYWORDS):
            return item
    return None


def find_px_contexts(page):
    tree = page.contexts.get_tree(root=page.tab_id)
    flat = flatten_contexts(tree.contexts)

    def collect_descendants(item, depth, acc):
        acc.append((depth, item))
        for child in getattr(item, "children", []) or []:
            collect_descendants(child, depth + 1, acc)

    result = []
    seen = set()
    for depth, item in flat:
        url = (item.url or "").lower()
        if any(key in url for key in PX_HOST_KEYWORDS):
            branch = []
            collect_descendants(item, depth, branch)
            for branch_depth, branch_item in branch:
                if branch_item.context in seen:
                    continue
                seen.add(branch_item.context)
                result.append((branch_depth, branch_item))
    return result


def score_probe_result(result):
    center_hit = result.get("centerHit") or {}
    score = 0
    score += int(result.get("elementCount", 0))
    score += int(result.get("buttonCount", 0)) * 10
    score += int(result.get("inputCount", 0)) * 10
    score += int(result.get("canvasCount", 0)) * 8
    score += int(result.get("svgNodeCount", 0)) * 3
    if center_hit.get("targetType") == "dom":
        score += 25
    if center_hit.get("tag") and center_hit.get("tag") not in ("html", "body"):
        score += 40
    if int(result.get("iframeCount", 0)) == 0:
        score += 15
    elif int(result.get("iframeCount", 0)) >= 2:
        score -= 12
    if center_hit.get("relativeXPath"):
        score += 30
    text = str(center_hit.get("text") or "").strip()
    if text:
        score += 10
    candidates = result.get("challengeCandidates") or []
    if candidates:
        best = candidates[0]
        if best.get("tag") and best.get("tag") not in ("html", "head", "body", "script", "style", "title"):
            score += 35
        if best.get("relativeXPath"):
            score += 20
        if best.get("targetType") == "canvas-host":
            score += 10
    return score


def choose_best_px_context(page, candidates):
    best = None
    diagnostics = []
    for depth, item in candidates:
        frame = page.get_frame(context_id=item.context)
        if frame is None:
            diagnostics.append(
                {
                    "depth": depth,
                    "context": item.context,
                    "url": item.url,
                    "attach": False,
                    "score": -1,
                }
            )
            continue

        try:
            result = probe_context(frame)
            score = score_probe_result(result)
            diagnostics.append(
                {
                    "depth": depth,
                    "context": item.context,
                    "url": item.url,
                    "attach": True,
                    "score": score,
                    "result": result,
                }
            )
            if best is None or score > best["score"] or (
                score == best["score"] and depth > best["depth"]
            ):
                best = {
                    "depth": depth,
                    "item": item,
                    "frame": frame,
                    "score": score,
                    "result": result,
                }
        except Exception as e:
            diagnostics.append(
                {
                    "depth": depth,
                    "context": item.context,
                    "url": item.url,
                    "attach": True,
                    "score": -1,
                    "error": str(e),
                }
            )
    return best, diagnostics


def probe_context(frame):
    script = r"""
    (() => {
        function safeXPathById(el) {
            if (!(el instanceof Element)) {
                return '';
            }
            if (el.id) {
                return `//*[@id=${JSON.stringify(el.id)}]`;
            }
            return '';
        }

        function getAbsoluteXPath(el) {
            if (!(el instanceof Element)) {
                return '';
            }
            const parts = [];
            let current = el;
            while (current && current.nodeType === 1) {
                const tag = String(current.tagName || '').toLowerCase();
                if (!tag) {
                    break;
                }
                let index = 1;
                let sibling = current.previousElementSibling;
                while (sibling) {
                    if (String(sibling.tagName || '').toLowerCase() === tag) {
                        index += 1;
                    }
                    sibling = sibling.previousElementSibling;
                }
                parts.unshift(`${tag}[${index}]`);
                current = current.parentElement;
            }
            return parts.length ? '/' + parts.join('/') : '';
        }

        function getCssSelector(el) {
            if (!(el instanceof Element)) {
                return '';
            }
            if (el.id) {
                return '#' + el.id;
            }
            const tag = String(el.tagName || '').toLowerCase();
            if (!tag) {
                return '';
            }
            const cls = typeof el.className === 'string'
                ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2)
                : [];
            if (cls.length) {
                return tag + cls.map((name) => '.' + name).join('');
            }
            return tag;
        }

        function normalizeText(value) {
            return String(value || '').replace(/\s+/g, ' ').trim();
        }

        function isChallengeLikeElement(el) {
            if (!(el instanceof Element)) {
                return false;
            }
            const tag = String(el.tagName || '').toLowerCase();
            const role = String(el.getAttribute('role') || '').toLowerCase();
            const idText = `${el.id || ''} ${el.className || ''} ${el.getAttribute('name') || ''}`.toLowerCase();
            const text = normalizeText(el.textContent || '').toLowerCase();

            if (['button', 'input', 'textarea', 'select', 'canvas', 'svg'].includes(tag)) {
                return true;
            }
            if (role && ['button', 'checkbox', 'switch', 'slider'].includes(role)) {
                return true;
            }
            if (el.hasAttribute('tabindex')) {
                return true;
            }
            if (/press|hold|verify|challenge|human|captcha/.test(text)) {
                return true;
            }
            if (/press|hold|verify|challenge|captcha|human|checkbox|slider|button/.test(idText)) {
                return true;
            }
            return false;
        }

        function scoreChallengeLikeElement(el) {
            if (!(el instanceof Element)) {
                return -1;
            }
            const tag = String(el.tagName || '').toLowerCase();
            const role = String(el.getAttribute('role') || '').toLowerCase();
            const text = normalizeText(el.textContent || '').toLowerCase();
            let score = 0;
            if (['button', 'input'].includes(tag)) {
                score += 50;
            }
            if (tag === 'canvas') {
                score += 30;
            }
            if (role === 'button') {
                score += 25;
            }
            if (el.hasAttribute('tabindex')) {
                score += 10;
            }
            if (/press/.test(text)) {
                score += 35;
            }
            if (/hold/.test(text)) {
                score += 25;
            }
            if (/verify|challenge|human|captcha/.test(text)) {
                score += 15;
            }
            if (el.id) {
                score += 6;
            }
            return score;
        }

        function collectChallengeCandidates() {
            const elements = Array.from(document.querySelectorAll('*')).filter(isChallengeLikeElement);
            const unique = [];
            const seen = new Set();
            for (const el of elements) {
                if (seen.has(el)) {
                    continue;
                }
                seen.add(el);
                unique.push(el);
            }
            return unique
                .map((el) => {
                    const tag = String(el.tagName || '').toLowerCase();
                    return {
                        score: scoreChallengeLikeElement(el),
                        targetType: tag === 'canvas' ? 'canvas-host' : 'dom',
                        tag: tag,
                        id: el.id || '',
                        className: typeof el.className === 'string' ? el.className : '',
                        role: el.getAttribute('role') || '',
                        text: normalizeText(el.textContent || '').slice(0, 160),
                        css: getCssSelector(el),
                        relativeXPath: safeXPathById(el),
                        absoluteXPath: getAbsoluteXPath(el),
                    };
                })
                .sort((a, b) => b.score - a.score)
                .slice(0, 12);
        }

        function centerHit() {
            const x = Math.max(1, Math.floor(window.innerWidth / 2));
            const y = Math.max(1, Math.floor(window.innerHeight / 2));
            const list = typeof document.elementsFromPoint === 'function'
                ? document.elementsFromPoint(x, y)
                : [];
            const target = list.find((el) => el instanceof Element) || document.elementFromPoint(x, y);
            if (!(target instanceof Element)) {
                return {
                    targetType: 'none',
                    point: {x, y},
                };
            }
            const tag = String(target.tagName || '').toLowerCase();
            return {
                targetType: tag === 'canvas' ? 'canvas-host' : 'dom',
                point: {x, y},
                tag: tag,
                id: target.id || '',
                className: typeof target.className === 'string' ? target.className : '',
                text: (target.textContent || '').trim().slice(0, 120),
                css: getCssSelector(target),
                relativeXPath: safeXPathById(target),
                absoluteXPath: getAbsoluteXPath(target),
            };
        }

        const all = Array.from(document.querySelectorAll('*'));
        const svgNodes = all.filter((el) => {
            const tag = String(el.tagName || '').toLowerCase();
            return ['svg', 'path', 'circle', 'rect', 'text'].includes(tag);
        }).slice(0, 12);

        return {
            locationHref: location.href,
            locationOrigin: location.origin,
            title: document.title,
            readyState: document.readyState,
            elementCount: all.length,
            iframeCount: document.querySelectorAll('iframe').length,
            buttonCount: document.querySelectorAll('button').length,
            inputCount: document.querySelectorAll('input').length,
            canvasCount: document.querySelectorAll('canvas').length,
            svgNodeCount: svgNodes.length,
            centerHit: centerHit(),
            challengeCandidates: collectChallengeCandidates(),
        };
    })()
    """
    return frame.run_js(script)


def print_probe_result(result):
    print("\n[3] child context probe")
    print("location.href:", result.get("locationHref", ""))
    print("location.origin:", result.get("locationOrigin", ""))
    print("title:", result.get("title", ""))
    print("readyState:", result.get("readyState", ""))
    print(
        "dom stats: elements={elementCount} iframes={iframeCount} buttons={buttonCount} inputs={inputCount} canvas={canvasCount} svg={svgNodeCount}".format(
            **result
        )
    )

    center_hit = result.get("centerHit") or {}
    print("center hit:", json.dumps(center_hit, ensure_ascii=False))

    if center_hit.get("relativeXPath"):
        print("relative XPath:", center_hit.get("relativeXPath"))
    if center_hit.get("absoluteXPath"):
        print("absolute XPath:", center_hit.get("absoluteXPath"))
    if center_hit.get("css"):
        print("css selector:", center_hit.get("css"))

    candidates = result.get("challengeCandidates") or []
    print("\n[3.1] challenge-like candidates")
    if not candidates:
        print("未扫描到明显的 challenge 候选元素。")
    else:
        for index, item in enumerate(candidates, start=1):
            print(
                "{}. score={} type={} tag={} id={} role={} text={}".format(
                    index,
                    item.get("score", 0),
                    item.get("targetType", ""),
                    item.get("tag", ""),
                    item.get("id", ""),
                    item.get("role", ""),
                    (item.get("text", "") or "")[:100],
                )
            )
            if item.get("relativeXPath"):
                print("   relative XPath:", item.get("relativeXPath"))
            if item.get("absoluteXPath"):
                print("   absolute XPath:", item.get("absoluteXPath"))
            if item.get("css"):
                print("   css selector:", item.get("css"))

    if center_hit.get("targetType") == "canvas-host":
        print("结论: 当前中心点命中的是 canvas 宿主元素，无法直接生成真实内部 XPath。")
    elif center_hit.get("targetType") == "dom":
        print("结论: 当前中心点命中了真实 DOM 元素，可继续在该 context 内做 selector/XPath 探测。")
    else:
        print("结论: 当前中心点没有拿到可用元素，页面可能仍在动态渲染或命中区域为空。")


def main():
    test_page = BASE_DIR / "test_pages" / "debug_px.html"
    file_url = test_page.resolve().as_uri()

    page = launch(
        headless=False,
        window_size=(1600, 1100),
        close_on_exit=False,
    )

    print("=" * 76)
    print("示例42_3: debug_px browsing context probe")
    print("页面地址:", file_url)
    print("目标: 诊断 debug_px.html 里的 PX iframe 到底能探测到哪一层。")
    print("说明: 这是 context 诊断示例，不保证任何 challenge 控件都能直接生成 XPath。")
    print("=" * 76)

    try:
        page.get(file_url)
        page.wait(1)

        print("\n[0] 等待页面里的 PX iframe 出现...")
        iframe, iframe_src = wait_for_px_iframe(page)
        if iframe is None:
            print("未在主页面中发现 iframe，示例继续打印当前 context tree 供排查。")
        else:
            print("找到主页面 iframe 元素。")
            print("iframe src:", iframe_src or "-")

        print_context_tree(page)

        px_ctx = None
        px_candidates = []
        end = time.time() + 25
        while time.time() < end and not px_candidates:
            px_candidates = find_px_contexts(page)
            if px_candidates and px_ctx is None:
                px_ctx = px_candidates[0][1]
                break
            time.sleep(0.5)

        print("\n[2] 尝试定位 PX child context")
        if not px_candidates:
            print("未在 context tree 中识别到 PX child context。")
            print("可能原因: 远程 iframe 尚未完成导航，或当前 challenge 结构已变化。")
        else:
            print("发现 {} 个 PX 相关 context。".format(len(px_candidates)))
            for depth, item in px_candidates:
                print("  depth={} context={} url={}".format(depth, item.context, item.url))

            best, diagnostics = choose_best_px_context(page, px_candidates)

            print("\n[2.1] 各 PX context 诊断分数")
            for item in diagnostics:
                print(
                    "  depth={depth} context={context} attach={attach} score={score} url={url}".format(
                        **item
                    )
                )

            if best is None:
                print("未能成功 attach 并探测任一 PX child context。")
            else:
                item = best["item"]
                frame = best["frame"]
                result = best["result"]

                print("\n选中的最优 context:", item.context)
                print("best url:", item.url)
                print("best depth:", best["depth"])
                print("diagnostic score:", best["score"])
                print("frame.is_cross_origin:", frame.is_cross_origin)
                print_probe_result(result)

        print("\n浏览器保持打开，方便继续手工观察 debug_px 页面。")
        print("按 Ctrl+C 结束脚本，浏览器不会由本示例主动关闭。")

        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n示例42_3结束。浏览器保持当前状态，已停止 Python 挂起循环。")


if __name__ == "__main__":
    main()
