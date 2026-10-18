# -*- coding: utf-8 -*-

import pytest


@pytest.mark.feature
@pytest.mark.local_server
def test_interceptor_can_mock_response(page, server):
    def handler(req):
        if "/api/data" in req.url:
            req.mock(
                '{"mocked": true}',
                headers={
                    "content-type": "application/json",
                    "access-control-allow-origin": "*",
                },
            )
        else:
            req.continue_request()

    page.get("about:blank")
    page.intercept.start_requests(handler)
    try:
        result = page.run_js(
            "return fetch(arguments[0]).then(r => r.json()).catch(e => ({error:String(e)}));",
            server.get_url("/api/data"),
            as_expr=False,
        )
    finally:
        page.intercept.stop()

    assert isinstance(result, dict)
    assert result.get("mocked") is True


@pytest.mark.feature
@pytest.mark.local_server
def test_interceptor_can_fail_request(page, server):
    def handler(req):
        if "/api/data" in req.url:
            req.fail()
        else:
            req.continue_request()

    page.get("about:blank")
    page.intercept.start_requests(handler)
    try:
        result = page.run_js(
            "return fetch(arguments[0]).then(() => 'ok').catch(e => 'blocked:' + e.name);",
            server.get_url("/api/data"),
            as_expr=False,
        )
    finally:
        page.intercept.stop()

    assert isinstance(result, str)
    assert result.startswith("blocked:")
