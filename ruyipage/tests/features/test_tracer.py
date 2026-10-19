# -*- coding: utf-8 -*-
"""tracer & diagnostics 功能测试

覆盖范围:
- TraceEntry / FailureSnapshot 数据结构
- Tracer 缓冲区操作（record/latest/clear/summary/dump_json）
- _scrub_dict 敏感字段清洗
- _summarize_params 参数摘要
- Tracer 线程安全
- FailureSnapshot 序列化
- Settings 集成
- errors.py diagnostics 属性
- FirefoxOptions 新方法
"""

import json
import time
import threading
import pytest

from ruyipage._units.tracer import (
    Tracer,
    TraceEntry,
    FailureSnapshot,
    _scrub_dict,
    _summarize_params,
)
from ruyipage._functions.settings import Settings
from ruyipage.errors import (
    RuyiPageError,
    ElementNotFoundError,
    BiDiError,
    JavaScriptError,
    WaitTimeoutError,
    PageDisconnectedError,
)
from ruyipage._configs.firefox_options import FirefoxOptions


# ─── TraceEntry ───


class TestTraceEntry:
    def test_basic_creation(self):
        e = TraceEntry("bidi_cmd", "browsingContext.navigate",
                       {"url": "https://example.com"}, context_id="ctx-1",
                       elapsed_ms=42.567, status="ok")
        assert e.category == "bidi_cmd"
        assert e.event == "browsingContext.navigate"
        assert e.data == {"url": "https://example.com"}
        assert e.context_id == "ctx-1"
        assert e.elapsed_ms == 42.57  # rounded to 2 decimals
        assert e.status == "ok"
        assert e.timestamp > 0

    def test_to_dict(self):
        e = TraceEntry("bidi_event", "network.responseCompleted",
                       {"context": "c1"}, context_id="c1")
        d = e.to_dict()
        assert d["cat"] == "bidi_event"
        assert d["evt"] == "network.responseCompleted"
        assert d["ctx"] == "c1"
        assert d["st"] == "ok"
        assert isinstance(d["ts"], float)

    def test_repr(self):
        e = TraceEntry("error", "element_not_found", status="warn")
        r = repr(e)
        assert "error" in r
        assert "element_not_found" in r
        assert "warn" in r

    def test_defaults(self):
        e = TraceEntry("bidi_cmd", "session.status")
        assert e.data == {}
        assert e.context_id is None
        assert e.elapsed_ms == 0
        assert e.status == "ok"


# ─── FailureSnapshot ───


class TestFailureSnapshot:
    def test_basic_creation(self):
        snap = FailureSnapshot()
        assert snap.timestamp > 0
        assert snap.error_type == ''
        assert snap.error_message == ''
        assert snap.url is None
        assert snap.screenshot_path is None
        assert snap.dom_path is None
        assert snap.recent_requests == []
        assert snap.trace_entries == []
        assert snap.context_id is None
        assert snap.saved_dir is None
        assert snap.capture_errors == []

    def test_to_dict(self):
        snap = FailureSnapshot()
        snap.error_type = "ElementNotFoundError"
        snap.error_message = "未找到元素: #btn"
        snap.url = "https://example.com"
        snap.context_id = "ctx-abc"
        snap.trace_entries = [
            TraceEntry("bidi_cmd", "test", elapsed_ms=10)
        ]
        snap.recent_requests = [
            {"url": "https://api.com", "status": 200}
        ]

        d = snap.to_dict()
        assert d["error_type"] == "ElementNotFoundError"
        assert d["url"] == "https://example.com"
        assert len(d["trace_entries"]) == 1
        assert d["trace_entries"][0]["cat"] == "bidi_cmd"
        assert len(d["recent_requests"]) == 1

    def test_to_json(self):
        snap = FailureSnapshot()
        snap.error_type = "TestError"
        snap.error_message = "test msg"
        j = snap.to_json()
        parsed = json.loads(j)
        assert parsed["error_type"] == "TestError"

    def test_summary(self):
        snap = FailureSnapshot()
        snap.error_type = "WaitTimeoutError"
        snap.error_message = "等待超时"
        snap.url = "https://example.com"
        snap.context_id = "ctx-123"
        snap.screenshot_path = "/tmp/screenshot.png"
        snap.saved_dir = "/tmp/output"
        s = snap.summary()
        assert "Failure Snapshot" in s
        assert "WaitTimeoutError" in s
        assert "https://example.com" in s
        assert "screenshot.png" in s
        assert "/tmp/output" in s

    def test_summary_with_capture_errors(self):
        snap = FailureSnapshot()
        snap.error_type = "Error"
        snap.error_message = "msg"
        snap.capture_errors = ["screenshot: connection lost"]
        s = snap.summary()
        assert "Capture warnings" in s
        assert "connection lost" in s

    def test_repr(self):
        snap = FailureSnapshot()
        snap.error_type = "BiDiError"
        snap.url = "https://test.com"
        r = repr(snap)
        assert "BiDiError" in r
        assert "test.com" in r


# ─── Scrub & Summarize ───


class TestScrubDict:
    def test_scrub_sensitive_keys(self):
        d = {"username": "admin", "password": "secret123", "url": "https://x.com"}
        result = _scrub_dict(d)
        assert result["password"] == "***"
        assert result["url"] == "https://x.com"
        assert result["username"] == "admin"  # username is not in sensitive list

    def test_scrub_nested(self):
        d = {"headers": {"authorization": "Bearer token123"}}
        result = _scrub_dict(d)
        assert result["headers"]["authorization"] == "***"

    def test_truncate_long_strings(self):
        d = {"script": "x" * 1000}
        result = _scrub_dict(d, max_str_len=100)
        assert len(result["script"]) < 200
        assert "truncated" in result["script"]

    def test_truncate_bare_string(self):
        s = "a" * 1000
        result = _scrub_dict(s, max_str_len=50)
        assert len(result) < 100
        assert "truncated" in result

    def test_none_passthrough(self):
        assert _scrub_dict(None) is None

    def test_int_passthrough(self):
        assert _scrub_dict(42) == 42

    def test_list_truncation(self):
        d = {"items": [{"cookie": "val"}] * 20}
        result = _scrub_dict(d)
        assert len(result["items"]) == 10  # max 10 items

    def test_cookie_key_scrubbed(self):
        d = {"Cookie": "session=abc123", "other": "safe"}
        result = _scrub_dict(d)
        assert result["Cookie"] == "***"
        assert result["other"] == "safe"


class TestSummarizeParams:
    def test_none_params(self):
        assert _summarize_params(None) == {}

    def test_empty_params(self):
        assert _summarize_params({}) == {}

    def test_basic_params(self):
        p = {"context": "ctx-1", "url": "https://example.com"}
        result = _summarize_params(p)
        assert result["context"] == "ctx-1"
        assert result["url"] == "https://example.com"


# ─── Tracer ───


class TestTracer:
    def setup_method(self):
        self._orig_trace = Settings.trace_enabled
        Settings.trace_enabled = True

    def teardown_method(self):
        Settings.trace_enabled = self._orig_trace

    def test_record_and_latest(self):
        t = Tracer(max_entries=100)
        t.record("bidi_cmd", "test.method", {"key": "val"},
                 context_id="c1", elapsed_ms=5)
        entries = t.latest(10)
        assert len(entries) == 1
        assert entries[0].event == "test.method"
        assert entries[0].data == {"key": "val"}

    def test_latest_limit(self):
        t = Tracer(max_entries=100)
        for i in range(50):
            t.record("bidi_cmd", "cmd_{}".format(i))
        assert len(t.latest(10)) == 10
        assert len(t.latest(100)) == 50

    def test_buffer_maxlen(self):
        t = Tracer(max_entries=10)
        for i in range(20):
            t.record("bidi_cmd", "cmd_{}".format(i))
        entries = t.latest(100)
        assert len(entries) == 10
        assert entries[0].event == "cmd_10"  # oldest surviving
        assert entries[-1].event == "cmd_19"

    def test_record_disabled(self):
        Settings.trace_enabled = False
        t = Tracer(max_entries=100)
        t.record("bidi_cmd", "should_not_record")
        assert len(t.latest(100)) == 0

    def test_record_net(self):
        t = Tracer(max_entries=100)
        t.record_net("responseCompleted", "https://api.com/data",
                     "GET", 200, context_id="c1")
        reqs = t.recent_requests(10)
        assert len(reqs) == 1
        assert reqs[0]["url"] == "https://api.com/data"
        assert reqs[0]["status"] == 200

    def test_clear(self):
        t = Tracer(max_entries=100)
        t.record("bidi_cmd", "test")
        t.record_net("responseCompleted", "https://x.com", "GET", 200)
        t.clear()
        assert len(t.latest(100)) == 0
        assert len(t.recent_requests(100)) == 0

    def test_dump_json(self):
        t = Tracer(max_entries=100)
        t.record("bidi_cmd", "test.cmd", {"url": "https://x.com"},
                 elapsed_ms=10)
        j = t.dump_json()
        parsed = json.loads(j)
        assert isinstance(parsed, list)
        assert len(parsed) == 1
        assert parsed[0]["evt"] == "test.cmd"

    def test_summary(self):
        t = Tracer(max_entries=100)
        t.record("bidi_cmd", "browsingContext.navigate",
                 elapsed_ms=150.5)
        t.record("bidi_event", "network.responseCompleted")
        s = t.summary()
        assert "Trace Summary" in s
        assert "browsingContext.navigate" in s
        assert "network.responseCompleted" in s

    def test_summary_empty(self):
        t = Tracer(max_entries=100)
        assert t.summary() == "(no trace entries)"

    def test_enabled_property(self):
        t = Tracer(max_entries=100)
        Settings.trace_enabled = True
        assert t.enabled is True
        Settings.trace_enabled = False
        assert t.enabled is False

    def test_repr(self):
        t = Tracer(max_entries=100)
        t.record("bidi_cmd", "test")
        t.record_net("fetchError", "https://x.com", "POST", 0)
        r = repr(t)
        assert "entries=1" in r
        assert "net=1" in r

    def test_thread_safety(self):
        """多线程并发写入不应导致异常或数据丢失"""
        t = Tracer(max_entries=5000)
        errors = []

        def writer(prefix, count):
            try:
                for i in range(count):
                    t.record("bidi_cmd", "{}_{}".format(prefix, i))
                    t.record_net("responseCompleted",
                                 "https://x.com/{}".format(i), "GET", 200)
            except Exception as e:
                errors.append(e)

        threads = [
            threading.Thread(target=writer, args=("t{}".format(i), 200))
            for i in range(10)
        ]
        for th in threads:
            th.start()
        for th in threads:
            th.join(timeout=10)

        assert not errors, "Thread safety violation: {}".format(errors)
        # Total 2000 records expected, buffer fits all
        entries = t.latest(5000)
        assert len(entries) == 2000
        reqs = t.recent_requests(5000)
        # net_buffer maxlen=50, so at most 50
        assert len(reqs) <= 50


# ─── Errors diagnostics attribute ───


class TestErrorsDiagnostics:
    def test_base_error_has_diagnostics_attr(self):
        err = RuyiPageError("test")
        assert hasattr(err, 'diagnostics')
        assert err.diagnostics is None

    def test_element_not_found_has_diagnostics(self):
        err = ElementNotFoundError("未找到")
        assert err.diagnostics is None

    def test_bidi_error_has_diagnostics(self):
        err = BiDiError("invalid argument", "msg", "stack")
        assert err.diagnostics is None
        assert err.error == "invalid argument"
        assert err.bidi_message == "msg"

    def test_js_error_has_diagnostics(self):
        err = JavaScriptError("eval error", {"text": "details"})
        assert err.diagnostics is None
        assert err.exception_details == {"text": "details"}

    def test_wait_timeout_has_diagnostics(self):
        err = WaitTimeoutError("超时")
        assert err.diagnostics is None

    def test_page_disconnected_has_diagnostics(self):
        err = PageDisconnectedError("断开")
        assert err.diagnostics is None

    def test_diagnostics_can_be_set(self):
        err = ElementNotFoundError("test")
        snap = FailureSnapshot()
        snap.error_type = "ElementNotFoundError"
        err.diagnostics = snap
        assert err.diagnostics is snap
        assert err.diagnostics.error_type == "ElementNotFoundError"

    def test_diagnostics_independent_per_instance(self):
        err1 = ElementNotFoundError("a")
        err2 = ElementNotFoundError("b")
        snap = FailureSnapshot()
        err1.diagnostics = snap
        assert err2.diagnostics is None  # class-level default still None


# ─── FirefoxOptions ───


class TestFirefoxOptionsTrace:
    def test_enable_trace(self):
        opts = FirefoxOptions()
        assert opts.trace_enabled is False
        result = opts.enable_trace(True)
        assert result is opts  # chain
        assert opts.trace_enabled is True
        opts.enable_trace(False)
        assert opts.trace_enabled is False

    def test_enable_failure_snapshot(self):
        opts = FirefoxOptions()
        assert opts.failure_snapshot_enabled is False
        result = opts.enable_failure_snapshot()
        assert result is opts
        assert opts.failure_snapshot_enabled is True

    def test_set_snapshot_dir(self):
        opts = FirefoxOptions()
        assert opts.snapshot_dir is None
        result = opts.set_snapshot_dir("./diag_output")
        assert result is opts
        assert opts.snapshot_dir is not None
        assert "diag_output" in opts.snapshot_dir

    def test_set_snapshot_dir_none(self):
        opts = FirefoxOptions()
        opts.set_snapshot_dir("./x")
        opts.set_snapshot_dir(None)
        assert opts.snapshot_dir is None

    def test_quick_start_with_trace(self):
        opts = FirefoxOptions()
        opts.quick_start(trace=True, failure_snapshot=True,
                         snapshot_dir="./test_snap")
        assert opts.trace_enabled is True
        assert opts.failure_snapshot_enabled is True
        assert opts.snapshot_dir is not None

    def test_quick_start_defaults(self):
        opts = FirefoxOptions()
        opts.quick_start()
        assert opts.trace_enabled is False
        assert opts.failure_snapshot_enabled is False
        assert opts.snapshot_dir is None


# ─── Settings fields ───


class TestSettingsFields:
    def test_trace_enabled_default(self):
        assert Settings.trace_enabled is False

    def test_trace_max_entries_default(self):
        assert Settings.trace_max_entries == 1000

    def test_failure_snapshot_enabled_default(self):
        assert Settings.failure_snapshot_enabled is False

    def test_snapshot_dom_max_bytes_default(self):
        assert Settings.snapshot_dom_max_bytes == 2 * 1024 * 1024

    def test_snapshot_recent_requests_default(self):
        assert Settings.snapshot_recent_requests == 30

    def test_settings_can_be_changed(self):
        orig = Settings.trace_enabled
        try:
            Settings.trace_enabled = True
            assert Settings.trace_enabled is True
        finally:
            Settings.trace_enabled = orig


# ─── Imports from __init__ ───


class TestPublicExports:
    def test_failure_snapshot_importable(self):
        from ruyipage import FailureSnapshot
        assert FailureSnapshot is not None

    def test_trace_entry_importable(self):
        from ruyipage import TraceEntry
        assert TraceEntry is not None
