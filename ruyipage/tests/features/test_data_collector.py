# -*- coding: utf-8 -*-

import pytest


@pytest.mark.feature
@pytest.mark.local_server
def test_data_collector_can_collect_response_body(page, server):
    collector = page.network.add_data_collector(["responseCompleted"], data_types=["response"])
    page.get("about:blank")
    page.intercept.start_requests()
    page.listen.start("/api/collector")

    try:
        page.run_js(
            "fetch(arguments[0]).catch(()=>null); return true;",
            server.get_url("/api/collector"),
            as_expr=False,
        )
        req = page.intercept.wait(timeout=8)
        assert req is not None
        req.continue_request()
        packet = page.listen.wait(timeout=8)
        assert packet is not None
        data = collector.get(req.request_id, data_type="response")
        assert data.has_data is True
    finally:
        page.listen.stop()
        page.intercept.stop()
        collector.remove()
