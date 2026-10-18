# -*- coding: utf-8 -*-
"""Regression tests for WindowManager runtime sizing."""

from ruyipage._units.window import WindowManager


class _FakeOwner:
    def __init__(self):
        self.calls = []

    def set_window_size(self, width, height):
        self.calls.append(("set_window_size", width, height))
        return self


def test_window_manager_set_size_uses_synchronized_page_size_api():
    owner = _FakeOwner()
    result = WindowManager(owner).set_size(1360, 700)

    assert result is owner
    assert owner.calls == [("set_window_size", 1360, 700)]
