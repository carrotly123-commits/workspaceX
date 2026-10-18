# -*- coding: utf-8 -*-

import json

import pytest

from ruyipage._units.capture import CapturePacket


def test_capture_packet_fallback_fetches_get_response_body_when_collector_empty():
    class EmptyCollector:
        def get(self, request_id, data_type="response"):
            raise RuntimeError("collector empty")

    class Owner:
        def __init__(self):
            self.calls = []

        def run_js(self, script, url, timeout=15):
            self.calls.append((script, url, timeout))
            return "<html>bing result body</html>"

    owner = Owner()
    packet = CapturePacket(
        request={
            "request": "req-1",
            "url": "https://cn.bing.com/search?q=ruyipage",
            "method": "GET",
        },
        response={"status": 200, "headers": []},
        response_collector=EmptyCollector(),
        owner=owner,
    )

    assert packet.response_body == "<html>bing result body</html>"
    assert owner.calls[0][1] == "https://cn.bing.com/search?q=ruyipage"


@pytest.mark.feature
@pytest.mark.local_server
def test_capture_can_collect_multiple_request_and_response_packets(page, server):
    page.get("about:blank")
    page.capture.start("/api/echo", method="POST")

    try:
        result = page.run_js(
            """
            const url = arguments[0];
            return Promise.all([
              fetch(url + "?n=1", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({n: 1})
              }).then(r => r.json()),
              fetch(url + "?n=2", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({n: 2})
              }).then(r => r.json())
            ]).catch(e => [{error: String(e)}]);
            """,
            server.get_url("/api/echo"),
            as_expr=False,
        )

        packets = page.capture.wait(timeout=8, count=2)
        assert len(packets) == 2

        bodies = [json.loads(packet.request_body) for packet in packets]
        assert {body["n"] for body in bodies} == {1, 2}
        assert all(packet.method == "POST" for packet in packets)
        assert all(packet.response_status == 200 for packet in packets)
        assert all("content-type" in packet.response_headers for packet in packets)
        assert all(packet.response_body for packet in packets)
        assert len(page.capture.steps) == 2
        assert result[0]["status"] == "ok"
    finally:
        page.capture.stop()


@pytest.mark.feature
@pytest.mark.local_server
def test_capture_wait_single_packet_returns_none_on_timeout(page):
    page.capture.start("/api/not-fired", method="GET")
    try:
        assert page.capture.wait(timeout=0.5) is None
    finally:
        page.capture.stop()
