# -*- coding: utf-8 -*-

from ruyipage._units.navigation import NavigationTracker
from ruyipage.errors import BiDiError


class FakeBrowserDriver:
    def __init__(self, unsupported_events=None):
        self.unsupported_events = set(unsupported_events or [])
        self.subscribe_calls = []
        self.unsubscribe_calls = []

    def run(self, method, params=None):
        if method == "session.subscribe":
            events = list(params["events"])
            self.subscribe_calls.append((events, params.get("contexts")))
            if self.unsupported_events.intersection(events):
                raise BiDiError("invalid argument", "unsupported event")
            return {"subscription": "sub-{}".format(len(self.subscribe_calls))}

        if method == "session.unsubscribe":
            self.unsubscribe_calls.append(params)
            return {}

        raise AssertionError(method)


class FakePageDriver:
    def __init__(self, browser_driver):
        self._browser_driver = browser_driver
        self.callbacks = {}

    def set_callback(self, event, callback):
        self.callbacks[event] = callback

    def remove_callback(self, event):
        self.callbacks.pop(event, None)


class FakeOwner:
    def __init__(self, unsupported_events=None):
        self._context_id = "ctx-1"
        browser_driver = FakeBrowserDriver(unsupported_events)
        self._driver = FakePageDriver(browser_driver)


def test_navigation_tracker_start_falls_back_when_one_event_invalid():
    owner = FakeOwner(
        unsupported_events={"browsingContext.navigationCommitted"},
    )
    tracker = NavigationTracker(owner)

    assert tracker.start() is True

    first_events, first_contexts = owner._driver._browser_driver.subscribe_calls[0]
    assert first_events == NavigationTracker.DEFAULT_EVENTS
    assert first_contexts == ["ctx-1"]
    assert "browsingContext.load" in owner._driver.callbacks
    assert "browsingContext.domContentLoaded" in owner._driver.callbacks
    assert "browsingContext.navigationStarted" in owner._driver.callbacks
    assert "browsingContext.navigationFailed" in owner._driver.callbacks
    assert "browsingContext.navigationCommitted" not in owner._driver.callbacks
    assert tracker._unsupported_events == ["browsingContext.navigationCommitted"]

    owner._driver.callbacks["browsingContext.load"](
        {
            "context": "ctx-1",
            "url": "https://example.test/",
            "navigation": "nav-1",
        }
    )
    event = tracker.wait_for_load(timeout=0.1)
    assert event is not None
    assert event.method == "browsingContext.load"
    assert event.url == "https://example.test/"

    tracker.stop()
    assert tracker.listening is False
    assert owner._driver._browser_driver.unsubscribe_calls


def test_navigation_tracker_start_returns_false_when_all_events_invalid():
    owner = FakeOwner(
        unsupported_events={"browsingContext.navigationStarted"},
    )
    tracker = NavigationTracker(owner)

    assert tracker.start(events=["browsingContext.navigationStarted"]) is False
    assert tracker.listening is False
    assert tracker.entries == []
    assert tracker._events == []
    assert owner._driver.callbacks == {}
