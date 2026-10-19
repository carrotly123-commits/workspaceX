# -*- coding: utf-8 -*-
"""Regression tests for pointer-drag action staging."""

from ruyipage._units.actions import Actions


class _FakeBrowserDriver:
    def __init__(self):
        self.calls = []

    def run(self, method, params):
        self.calls.append((method, params))


class _FakeDriver:
    def __init__(self):
        self._browser_driver = _FakeBrowserDriver()


class _FakeRect:
    viewport_size = (1280, 900)


class _FakeOwner:
    _context_id = "context-1"
    _browser = None

    def __init__(self):
        self._driver = _FakeDriver()
        self.rect = _FakeRect()

    def run_js(self, *args, **kwargs):
        return None


def _perform_calls(actions):
    owner = actions._owner
    return [
        params["actions"]
        for method, params in owner._driver._browser_driver.calls
        if method == "input.performActions"
    ]


def test_waits_inside_pointer_drag_are_sent_as_one_perform_actions_call():
    owner = _FakeOwner()
    actions = Actions(owner)

    actions.move_to((100, 100)).hold().wait(0.1).move_to((260, 100)).wait(0.1).release().perform()

    calls = _perform_calls(actions)

    assert len(calls) == 1
    pointer_source = calls[0][0]
    assert pointer_source["type"] == "pointer"

    action_types = [action["type"] for action in pointer_source["actions"]]
    assert action_types == [
        "pointerMove",
        "pointerDown",
        "pause",
        "pointerMove",
        "pause",
        "pointerUp",
    ]


def test_wait_between_click_and_type_stays_sequential_not_parallel():
    owner = _FakeOwner()
    actions = Actions(owner)

    actions.move_to((100, 100)).click().wait(0.1).type("x").perform()

    calls = _perform_calls(actions)

    assert len(calls) == 3
    assert calls[0][0]["type"] == "pointer"
    assert {source["type"] for source in calls[1]} == {"pointer", "key"}
    assert calls[2][0]["type"] == "key"


def test_non_pointer_action_inside_hold_does_not_reorder_pointer_down():
    owner = _FakeOwner()
    actions = Actions(owner)

    actions.move_to((100, 100)).hold().key_down("x").key_up("x").release().perform()

    calls = _perform_calls(actions)

    assert len(calls) == 3
    assert [source["type"] for source in calls[0]] == ["pointer"]
    assert [action["type"] for action in calls[0][0]["actions"]] == [
        "pointerMove",
        "pointerDown",
    ]
    assert [source["type"] for source in calls[1]] == ["key"]
    assert [source["type"] for source in calls[2]] == ["pointer"]
    assert calls[2][0]["actions"] == [{"type": "pointerUp", "button": 0}]
