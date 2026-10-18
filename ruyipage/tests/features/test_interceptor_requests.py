# -*- coding: utf-8 -*-

import pytest


@pytest.mark.feature
@pytest.mark.local_server
def test_before_request_interceptor_can_inject_headers(page, server):
    def handler(req):
        if "/api/headers" in req.url:
            req.continue_request(headers={"X-Ruyi-Demo": "yes"})
        else:
            req.continue_request()

    page.get("about:blank")
    page.intercept.start_requests(handler)
    try:
        result = page.run_js(
            """
            return fetch(arguments[0]).then(r => r.json()).catch(e => ({error:String(e)}));
            """,
            server.get_url("/api/headers"),
            as_expr=False,
        )
    finally:
        page.intercept.stop()

    assert isinstance(result, dict)
    assert (result.get("X-Ruyi-Demo") or result.get("x-ruyi-demo")) == "yes"
