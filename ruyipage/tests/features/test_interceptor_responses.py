# -*- coding: utf-8 -*-

import pytest


@pytest.mark.feature
@pytest.mark.local_server
def test_response_interceptor_can_read_response_body(page, server):
    captured = []

    def handler(req):
        if "/api/data" in req.url:
            req.continue_response()
            captured.append(
                {
                    "status": req.response_status,
                    "headers": req.response_headers or {},
                    "body": req.response_body,
                }
            )
        else:
            req.continue_response()

    page.get("about:blank")
    page.intercept.start_responses(handler, collect_response=True)
    try:
        result = page.run_js(
            """
            return fetch(arguments[0]).then(r => r.status + ':' + r.statusText).catch(e => String(e));
            """,
            server.get_url("/api/data"),
            as_expr=False,
        )
        page.wait(0.8)
    finally:
        page.intercept.stop()

    assert result == "200:OK"
    assert captured
    assert captured[0]["status"] == 200
    assert '"status": "ok"' in (captured[0]["body"] or "")
