# -*- coding: utf-8 -*-
"""response_body 慢响应超时测试。

验证 response_body / get_response_body(timeout=...) 在慢响应场景下
的正确行为，确保指数退避轮询机制能等到 responseCompleted 事件。
"""

import json

import pytest

from ruyipage._functions.settings import Settings


@pytest.mark.feature
@pytest.mark.local_server
def test_slow_response_body_within_default_timeout(page, server):
    """2 秒慢响应在默认超时 (10s) 内应能成功读取 body。"""
    captured = []

    def handler(req):
        if "/api/slow" in req.url:
            req.continue_response()
            captured.append(req.response_body)
        else:
            req.continue_response()

    page.get("about:blank")
    page.intercept.start_responses(handler, collect_response=True)
    try:
        result = page.run_js(
            """
            return fetch(arguments[0]).then(r => r.status + ':' + r.statusText).catch(e => String(e));
            """,
            server.get_url("/api/slow?delay=2"),
            as_expr=False,
        )
        page.wait(4)
    finally:
        page.intercept.stop()

    assert result == "200:OK"
    assert captured, "应至少捕获到一个响应"
    body = captured[0]
    assert body is not None, "2s 慢响应在默认 10s 超时内应能读取到 body"
    data = json.loads(body)
    assert data["status"] == "ok"
    assert data["delayed"] == 2


@pytest.mark.feature
@pytest.mark.local_server
def test_slow_response_get_response_body_custom_timeout(page, server):
    """使用 get_response_body(timeout=...) 自定义超时读取慢响应。"""
    captured = []

    def handler(req):
        if "/api/slow" in req.url:
            req.continue_response()
            captured.append(req.get_response_body(timeout=15))
        else:
            req.continue_response()

    page.get("about:blank")
    page.intercept.start_responses(handler, collect_response=True)
    try:
        result = page.run_js(
            """
            return fetch(arguments[0]).then(r => r.status + ':' + r.statusText).catch(e => String(e));
            """,
            server.get_url("/api/slow?delay=3"),
            as_expr=False,
        )
        page.wait(5)
    finally:
        page.intercept.stop()

    assert result == "200:OK"
    assert captured, "应至少捕获到一个响应"
    body = captured[0]
    assert body is not None, "3s 慢响应在 15s 自定义超时内应能读取到 body"
    data = json.loads(body)
    assert data["status"] == "ok"
    assert data["delayed"] == 3


@pytest.mark.feature
@pytest.mark.local_server
def test_response_body_without_collect_response_returns_none(page, server):
    """未启用 collect_response 时 response_body 应返回 None。"""
    captured = []

    def handler(req):
        if "/api/data" in req.url:
            req.continue_response()
            captured.append(req.response_body)
        else:
            req.continue_response()

    page.get("about:blank")
    page.intercept.start_responses(handler, collect_response=False)
    try:
        page.run_js(
            """
            return fetch(arguments[0]).then(r => r.status + ':' + r.statusText).catch(e => String(e));
            """,
            server.get_url("/api/data"),
            as_expr=False,
        )
        page.wait(1)
    finally:
        page.intercept.stop()

    assert captured, "应至少捕获到一个响应"
    assert captured[0] is None, "未启用 collect_response 时 response_body 应返回 None"


@pytest.mark.feature
@pytest.mark.local_server
def test_get_response_body_without_collect_response_returns_none(page, server):
    """未启用 collect_response 时 get_response_body() 也应返回 None。"""
    captured = []

    def handler(req):
        if "/api/data" in req.url:
            req.continue_response()
            captured.append(req.get_response_body(timeout=5))
        else:
            req.continue_response()

    page.get("about:blank")
    page.intercept.start_responses(handler, collect_response=False)
    try:
        page.run_js(
            """
            return fetch(arguments[0]).then(r => r.status + ':' + r.statusText).catch(e => String(e));
            """,
            server.get_url("/api/data"),
            as_expr=False,
        )
        page.wait(1)
    finally:
        page.intercept.stop()

    assert captured, "应至少捕获到一个响应"
    assert captured[0] is None, "未启用 collect_response 时 get_response_body 应返回 None"


@pytest.mark.feature
@pytest.mark.local_server
def test_fast_response_still_works(page, server):
    """快速响应 (无延迟) 不应受重构影响，仍然正常工作。"""
    captured = []

    def handler(req):
        if "/api/data" in req.url:
            req.continue_response()
            captured.append(req.response_body)
        else:
            req.continue_response()

    page.get("about:blank")
    page.intercept.start_responses(handler, collect_response=True)
    try:
        page.run_js(
            """
            return fetch(arguments[0]).then(r => r.status + ':' + r.statusText).catch(e => String(e));
            """,
            server.get_url("/api/data"),
            as_expr=False,
        )
        page.wait(1)
    finally:
        page.intercept.stop()

    assert captured, "应至少捕获到一个响应"
    body = captured[0]
    assert body is not None, "快速响应应能正常读取 body"
    assert '"status": "ok"' in body


@pytest.mark.feature
@pytest.mark.local_server
def test_settings_default_value(page, server):
    """Settings.response_body_timeout 默认值应为 10。"""
    assert Settings.response_body_timeout == 10
