# -*- coding: utf-8 -*-

from types import SimpleNamespace
from unittest import mock

import ruyipage


def test_attach_supports_xpath_picker(monkeypatch):
    captured = []

    class FakePage:
        def __init__(self, opts):
            captured.append(opts)
            self._browser = SimpleNamespace(options=opts)
            self._maybe_enable_xpath_picker = mock.Mock()

    monkeypatch.setattr(ruyipage, "FirefoxPage", FakePage)

    page = ruyipage.attach("127.0.0.1:8355", xpath_picker=True)

    assert isinstance(page, FakePage)
    assert captured[0].address == "127.0.0.1:8355"
    assert captured[0].is_existing_only is True
    assert captured[0].xpath_picker_enabled is True
    page._maybe_enable_xpath_picker.assert_called_once_with()


def test_attach_keeps_xpath_picker_disabled_by_default(monkeypatch):
    captured = []

    class FakePage:
        def __init__(self, opts):
            captured.append(opts)

    monkeypatch.setattr(ruyipage, "FirefoxPage", FakePage)

    ruyipage.attach("127.0.0.1:8355")

    assert captured[0].xpath_picker_enabled is False


def test_attach_exist_browser_forwards_xpath_picker_and_reinjects(monkeypatch):
    attach_calls = []

    class FakeContextDriver:
        def __init__(self, browser_driver, context_id):
            self.browser_driver = browser_driver
            self.context_id = context_id

    tab = SimpleNamespace(tab_id="ctx-2")
    browser = SimpleNamespace(driver=object(), activate_tab=mock.Mock())
    page = SimpleNamespace(
        browser=browser,
        _context_id="ctx-1",
        _driver=FakeContextDriver(object(), "ctx-1"),
        get_tab=mock.Mock(return_value=tab),
        _maybe_enable_xpath_picker=mock.Mock(),
    )

    def fake_attach(address, xpath_picker=False):
        attach_calls.append((address, xpath_picker))
        return page

    monkeypatch.setattr(ruyipage, "attach", fake_attach)

    result = ruyipage.attach_exist_browser(
        "127.0.0.1:8355",
        tab_index=2,
        xpath_picker=True,
    )

    assert result is page
    assert attach_calls == [("127.0.0.1:8355", True)]
    page.get_tab.assert_called_once_with(2)
    browser.activate_tab.assert_called_once_with(tab)
    assert page._context_id == "ctx-2"
    assert page._driver.browser_driver is browser.driver
    assert page._driver.context_id == "ctx-2"
    page._maybe_enable_xpath_picker.assert_called_once_with()
