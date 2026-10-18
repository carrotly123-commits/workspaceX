# -*- coding: utf-8 -*-
r"""Example 53: Capture Duck.ai chat EventStream with ruyiPage.

This example launches Firefox, opens ``https://duck.ai/duckchat/``, submits a
chat prompt, and intercepts the POST request to:

    https://duck.ai/duckchat/v1/chat

It prints the request shape and the ``text/event-stream`` response body preview.

Run:

    python examples/53_duckai_eventstream_capture.py

Useful overrides:

    python examples/53_duckai_eventstream_capture.py ^
        --browser-path C:\firefox\firefox\obj-x86_64-pc-windows-msvc\dist\bin\firefox.exe ^
        --proxy http://127.0.0.1:7890 ^
        --message "Reply with exactly: ruyipage capture ok"
"""

from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import sys
import tempfile
import time
from typing import Any, Callable, Dict, List, Optional


if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ruyipage import Keys, launch  # noqa: E402


DEFAULT_BROWSER_PATH = (
    r"C:\firefox\firefox\obj-x86_64-pc-windows-msvc\dist\bin\firefox.exe"
)
DEFAULT_PROXY = "http://127.0.0.1:7890"
PAGE_URL = "https://duck.ai/duckchat/"
TARGET_URL = "https://duck.ai/duckchat/v1/chat"
TEXTAREA_XPATH = (
    "/html/body/div[1]/div/main/section[2]/div[3]/form/div[2]/div/"
    "div[2]/div/div[1]/textarea"
)
DEFAULT_MESSAGE = "Reply with exactly: ruyipage capture ok"


def preview(value: Any, limit: int = 1200) -> str:
    text = "" if value is None else str(value)
    text = text.replace("\r", "\\r").replace("\n", "\\n")
    if len(text) > limit:
        return text[:limit] + "...<truncated>"
    return text


def safe_json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


def wait_for(
    predicate: Callable[[], Any],
    timeout: float,
    interval: float = 0.25,
    label: str = "condition",
) -> Any:
    deadline = time.time() + timeout
    last: Any = None
    while time.time() < deadline:
        try:
            last = predicate()
            if last:
                return last
        except Exception as exc:  # noqa: BLE001 - diagnostic helper
            last = repr(exc)
        time.sleep(interval)
    raise TimeoutError("timeout waiting for {} (last={!r})".format(label, last))


def page_dom_snapshot(page) -> Dict[str, Any]:
    return page.run_js(
        """
        const xp = arguments[0];
        const xnode = document.evaluate(
          xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;
        const textarea = document.querySelector('textarea');
        const submit = document.querySelector('form button[type="submit"], form [type="submit"]');

        function info(el) {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            text: (el.innerText || el.textContent || '').trim(),
            aria: el.getAttribute('aria-label'),
            type: el.getAttribute('type'),
            disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
            visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
            rect: {
              x: Math.round(r.x),
              y: Math.round(r.y),
              width: Math.round(r.width),
              height: Math.round(r.height)
            },
            value: 'value' in el ? el.value : undefined,
            isXPathNode: el === xnode,
            active: document.activeElement === el
          };
        }

        return {
          title: document.title,
          url: location.href,
          ready: document.readyState,
          xpathNode: info(xnode),
          textarea: info(textarea),
          submit: info(submit)
        };
        """,
        TEXTAREA_XPATH,
        as_expr=False,
        timeout=10,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Capture Duck.ai /duckchat/v1/chat EventStream with ruyiPage"
    )
    parser.add_argument(
        "--browser-path",
        default=os.getenv("RUYIPAGE_FIREFOX_PATH", DEFAULT_BROWSER_PATH),
        help="Firefox executable path",
    )
    parser.add_argument(
        "--proxy",
        default=os.getenv("RUYIPAGE_PROXY", DEFAULT_PROXY),
        help="Firefox proxy, for example http://127.0.0.1:7890; empty disables it",
    )
    parser.add_argument(
        "--message",
        default=os.getenv("RUYIPAGE_DUCKAI_MESSAGE", DEFAULT_MESSAGE),
        help="Prompt submitted to Duck.ai",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="run Firefox headless",
    )
    parser.add_argument(
        "--keep-profile",
        action="store_true",
        help="keep the temporary Firefox profile for debugging",
    )
    parser.add_argument(
        "--no-quit",
        action="store_true",
        help="leave Firefox open after the script finishes",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    profile_dir = tempfile.mkdtemp(prefix="ruyipage-duckai-profile-")
    proxy = args.proxy.strip() or None

    target_requests: List[Dict[str, Any]] = []
    target_responses: List[Dict[str, Any]] = []
    errors: List[str] = []
    page = None

    def is_target(req) -> bool:
        return req.url.split("?", 1)[0] == TARGET_URL

    def handler(req) -> None:
        try:
            if is_target(req):
                if req.is_response_phase:
                    item = {
                        "request_id": req.request_id,
                        "method": req.method,
                        "url": req.url,
                        "status": req.response_status,
                        "headers": req.response_headers or {},
                        "req_obj": req,
                    }
                    target_responses.append(item)
                    print("\n[target responseStarted]")
                    print(
                        safe_json(
                            {
                                key: value
                                for key, value in item.items()
                                if key != "req_obj"
                            }
                        )
                    )
                else:
                    item = {
                        "request_id": req.request_id,
                        "method": req.method,
                        "url": req.url,
                        "headers": req.headers,
                        "body": req.body or "",
                        "req_obj": req,
                    }
                    target_requests.append(item)
                    print("\n[target beforeRequestSent]")
                    print(
                        safe_json(
                            {
                                key: preview(value, 2000)
                                if key == "body"
                                else value
                                for key, value in item.items()
                                if key != "req_obj"
                            }
                        )
                    )

            if req.is_response_phase:
                req.continue_response()
            else:
                req.continue_request()
        except Exception as exc:  # noqa: BLE001 - do not leave intercepted requests hanging
            errors.append("handler: {!r}".format(exc))
            try:
                if req.is_response_phase:
                    req.continue_response()
                else:
                    req.continue_request()
            except Exception as fallback_exc:  # noqa: BLE001
                errors.append("handler fallback: {!r}".format(fallback_exc))

    try:
        print("=" * 70)
        print("Example 53: Duck.ai EventStream Capture")
        print("=" * 70)
        print("Firefox: {}".format(args.browser_path))
        print("Proxy: {}".format(proxy or "<disabled>"))
        print("Profile: {}".format(profile_dir))
        print("Target: {}".format(TARGET_URL))

        page = launch(
            browser_path=args.browser_path,
            user_dir=profile_dir,
            proxy=proxy,
            headless=args.headless,
            close_on_exit=not args.no_quit,
            window_size=(1400, 900),
        )
        page.intercept.start(
            handler=handler,
            phases=["beforeRequestSent", "responseStarted"],
            collect_response=True,
        )

        try:
            page.get(PAGE_URL, wait="interactive", timeout=60)
        except Exception as exc:  # noqa: BLE001 - Duck.ai can keep navigation open
            print("[navigate warning] {!r}".format(exc))

        wait_for(
            lambda: page_dom_snapshot(page).get("textarea"),
            timeout=60,
            label="Duck.ai textarea",
        )

        dom = page_dom_snapshot(page)
        if not dom.get("xpathNode"):
            print("[note] The provided absolute XPath did not match this page build.")
            print("[note] Falling back to css:textarea.")

        textarea = page.ele("xpath:" + TEXTAREA_XPATH, timeout=3)
        if not textarea:
            textarea = page.ele("css:textarea", timeout=10)
        if not textarea:
            raise RuntimeError("Duck.ai textarea not found: {}".format(safe_json(dom)))

        textarea.click_self()
        time.sleep(0.2)
        textarea.input(args.message, clear=True, by_js=False)
        time.sleep(0.5)

        # Some Duck.ai builds do not submit from Enter for synthetic key actions.
        # Try Enter first because it mirrors manual use, then click the exact form submit.
        page.actions.press(Keys.ENTER).perform()
        time.sleep(5)
        submit_method = "enter"

        if not target_requests:
            submit_method = "click_submit_after_enter"
            clicked = page.run_js(
                """
                const btn = document.querySelector(
                  'form button[type="submit"], form [type="submit"]'
                );
                if (!btn) return {clicked: false, reason: 'submit button not found'};
                btn.click();
                return {
                  clicked: true,
                  text: (btn.innerText || btn.textContent || '').trim(),
                  aria: btn.getAttribute('aria-label'),
                  disabled: !!btn.disabled || btn.getAttribute('aria-disabled') === 'true'
                };
                """,
                as_expr=False,
                timeout=10,
            )
            print("\n[submit click fallback]")
            print(safe_json(clicked))

        wait_for(lambda: target_requests, timeout=45, label="target POST request")
        wait_for(lambda: target_responses, timeout=90, label="target responseStarted")

        response_obj = target_responses[0].get("req_obj")
        request_obj = target_requests[0].get("req_obj")
        body_source = response_obj or request_obj
        stream_body: Optional[str] = None
        if body_source is not None:
            print("\n[body] waiting for responseCompleted data...")
            stream_body = body_source.get_response_body(timeout=120)

        request = target_requests[0]
        response = target_responses[0]
        request_headers = {
            str(key).lower(): value for key, value in request.get("headers", {}).items()
        }
        response_headers = {
            str(key).lower(): value for key, value in response.get("headers", {}).items()
        }

        result = {
            "submit_method": submit_method,
            "request": {
                "request_id": request.get("request_id"),
                "method": request.get("method"),
                "url": request.get("url"),
                "origin": request_headers.get("origin"),
                "referer": request_headers.get("referer"),
                "accept": request_headers.get("accept"),
                "content_type": request_headers.get("content-type"),
                "body_preview": preview(request.get("body"), 2000),
            },
            "response": {
                "request_id": response.get("request_id"),
                "status": response.get("status"),
                "content_type": response_headers.get("content-type"),
                "cache_control": response_headers.get("cache-control"),
                "body_len": len(stream_body) if stream_body is not None else None,
                "body_preview": preview(stream_body, 5000),
            },
            "errors": errors,
        }

        print("\n=== Duck.ai Capture Result ===")
        print(safe_json(result))

        if result["response"]["status"] != 200:
            raise RuntimeError("unexpected response status: {}".format(result["response"]["status"]))
        if result["response"]["content_type"] != "text/event-stream":
            raise RuntimeError(
                "unexpected response content-type: {}".format(
                    result["response"]["content_type"]
                )
            )
        if not stream_body:
            raise RuntimeError("empty EventStream response body")

        print("\n[OK] Captured Duck.ai EventStream response.")
        return 0
    finally:
        if page is not None and not args.no_quit:
            try:
                page.intercept.stop()
            except Exception:
                pass
            try:
                page.quit(timeout=10, force=True)
            except Exception:
                pass
        if not args.keep_profile:
            shutil.rmtree(profile_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
