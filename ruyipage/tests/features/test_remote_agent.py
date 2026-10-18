# -*- coding: utf-8 -*-

import json
import time
import urllib.request

from ruyipage._adapter import remote_agent


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return json.dumps(self._payload).encode()


def test_get_bidi_ws_url_prefers_json_without_root_ws_probe(monkeypatch):
    probes = []

    def fake_probe(ws_url, timeout=3):
        probes.append(ws_url)
        return False

    monkeypatch.setattr(remote_agent, "_probe_ws_url", fake_probe)
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda url, timeout=3: _FakeResponse(
            {"webSocketDebuggerUrl": "ws://127.0.0.1:9222/session"}
        ),
    )

    assert remote_agent.get_bidi_ws_url("127.0.0.1", 9222, timeout=1) == (
        "ws://127.0.0.1:9222/session"
    )
    assert probes == []


def test_get_bidi_ws_url_falls_back_to_root_ws_when_json_unavailable(monkeypatch):
    def fake_urlopen(url, timeout=3):
        raise OSError("not ready")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(
        remote_agent,
        "_probe_ws_url",
        lambda ws_url, timeout=3: ws_url == "ws://127.0.0.1:9222",
    )

    assert remote_agent.get_bidi_ws_url("127.0.0.1", 9222, timeout=0.01) == (
        "ws://127.0.0.1:9222"
    )


def test_get_bidi_ws_url_uses_session_when_json_unavailable_and_root_fails(monkeypatch):
    def fake_urlopen(url, timeout=3):
        raise OSError("not ready")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(
        remote_agent,
        "_probe_ws_url",
        lambda ws_url, timeout=3: ws_url == "ws://127.0.0.1:9222/session",
    )

    start = time.monotonic()
    assert remote_agent.get_bidi_ws_url("127.0.0.1", 9222, timeout=2) == (
        "ws://127.0.0.1:9222/session"
    )
    assert time.monotonic() - start < 0.5


def test_get_bidi_ws_url_skips_cdp_url_and_uses_session_fallback(monkeypatch):
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda url, timeout=3: _FakeResponse(
            {"webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/abc"}
        ),
    )
    monkeypatch.setattr(
        remote_agent,
        "_probe_ws_url",
        lambda ws_url, timeout=3: ws_url == "ws://127.0.0.1:9222/session",
    )

    assert remote_agent.get_bidi_ws_url("127.0.0.1", 9222, timeout=0.01) == (
        "ws://127.0.0.1:9222/session"
    )
