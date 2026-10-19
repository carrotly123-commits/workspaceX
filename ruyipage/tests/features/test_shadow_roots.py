# -*- coding: utf-8 -*-

from types import SimpleNamespace

import pytest

from ruyipage._elements.firefox_element import FirefoxElement
from ruyipage._pages.firefox_base import FirefoxBase
from ruyipage.errors import BiDiError


class FakeBrowserDriver:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def run(self, method, params=None, timeout=None):
        self.calls.append((method, params, timeout))
        if self.error is not None:
            raise self.error
        return self.response


class ContextResponseDriver:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def run(self, method, params=None, timeout=None):
        self.calls.append((method, params, timeout))
        if method == "script.evaluate":
            context = params["target"]["context"]
            return self.responses[context]
        if method == "browsingContext.getTree":
            return {"contexts": []}
        raise AssertionError(f"unexpected method: {method}")


def make_page(response=None, error=None):
    browser_driver = FakeBrowserDriver(response=response, error=error)
    page = object.__new__(FirefoxBase)
    page._context_id = "ctx-1"
    page._driver = SimpleNamespace(_browser_driver=browser_driver)
    return page, browser_driver


def make_context(context_id, driver, frames=()):
    context = object.__new__(FirefoxBase)
    context._context_id = context_id
    context._driver = SimpleNamespace(_browser_driver=driver)
    context.get_frames = lambda: list(frames)
    return context


def make_single_shadow_response(root_id, mode="closed"):
    return {
        "type": "success",
        "result": {
            "type": "node",
            "sharedId": f"{root_id}-html",
            "value": {
                "nodeType": 1,
                "localName": "html",
                "children": [
                    {
                        "type": "node",
                        "sharedId": f"{root_id}-host",
                        "value": {
                            "nodeType": 1,
                            "localName": "div",
                            "shadowRoot": {
                                "type": "node",
                                "sharedId": root_id,
                                "value": {"nodeType": 11, "mode": mode},
                            },
                        },
                    }
                ],
            },
        },
    }


def make_dom_response():
    return {
        "type": "success",
        "result": {
            "type": "node",
            "sharedId": "html-id",
            "value": {
                "nodeType": 1,
                "localName": "html",
                "children": [
                    {
                        "type": "node",
                        "sharedId": "open-host-id",
                        "value": {
                            "nodeType": 1,
                            "localName": "div",
                            "shadowRoot": {
                                "type": "node",
                                "sharedId": "open-root-id",
                                "value": {
                                    "nodeType": 11,
                                    "mode": "open",
                                    "childNodeCount": 1,
                                    "children": [
                                        {
                                            "type": "node",
                                            "sharedId": "nested-host-id",
                                            "value": {
                                                "nodeType": 1,
                                                "localName": "span",
                                                "shadowRoot": {
                                                    "type": "node",
                                                    "sharedId": "nested-closed-root-id",
                                                    "value": {
                                                        "nodeType": 11,
                                                        "mode": "closed",
                                                    },
                                                },
                                            },
                                        }
                                    ],
                                },
                            },
                        },
                    },
                    {
                        "type": "node",
                        "sharedId": "closed-host-id",
                        "value": {
                            "nodeType": 1,
                            "localName": "section",
                            "shadowRoot": {
                                "type": "node",
                                "sharedId": "closed-root-id",
                                "value": {"nodeType": 11, "mode": "closed"},
                            },
                        },
                    },
                ],
            },
        },
    }


def test_shadow_roots_collects_open_and_closed_roots_recursively():
    page, driver = make_page(response=make_dom_response())

    roots = page.shadow_roots()

    assert [root._shared_id for root in roots] == [
        "open-root-id",
        "nested-closed-root-id",
        "closed-root-id",
    ]
    assert all(isinstance(root, FirefoxElement) for root in roots)
    assert [root._node_info.get("mode") for root in roots] == [
        "open",
        "closed",
        "closed",
    ]

    method, params, timeout = driver.calls[0]
    assert method == "script.evaluate"
    assert timeout is None
    assert params["target"] == {"context": "ctx-1"}
    assert params["expression"] == "document.documentElement"
    assert params["serializationOptions"] == {
        "maxDomDepth": None,
        "includeShadowTree": "all",
    }


def test_shadow_roots_recurses_into_descendant_frames_by_default():
    driver = ContextResponseDriver(
        {
            "page-ctx": make_single_shadow_response("page-root", "open"),
            "frame-ctx": make_single_shadow_response("frame-root", "closed"),
            "nested-frame-ctx": make_single_shadow_response("nested-root", "closed"),
        }
    )
    nested_frame = make_context("nested-frame-ctx", driver)
    frame = make_context("frame-ctx", driver, frames=[nested_frame])
    page = make_context("page-ctx", driver, frames=[frame])

    roots = page.shadow_roots()

    assert [root._shared_id for root in roots] == [
        "page-root",
        "frame-root",
        "nested-root",
    ]
    assert [root._owner for root in roots] == [page, frame, nested_frame]


def test_shadow_roots_can_limit_scan_to_current_context():
    driver = ContextResponseDriver(
        {
            "page-ctx": make_single_shadow_response("page-root", "open"),
            "frame-ctx": make_single_shadow_response("frame-root", "closed"),
        }
    )
    frame = make_context("frame-ctx", driver)
    page = make_context("page-ctx", driver, frames=[frame])

    roots = page.shadow_roots(include_frames=False)

    assert [root._shared_id for root in roots] == ["page-root"]
    evaluated_contexts = [
        params["target"]["context"]
        for method, params, _timeout in driver.calls
        if method == "script.evaluate"
    ]
    assert evaluated_contexts == ["page-ctx"]


def test_shadow_roots_filters_by_mode():
    page, _driver = make_page(response=make_dom_response())

    assert [root._shared_id for root in page.shadow_roots("closed")] == [
        "nested-closed-root-id",
        "closed-root-id",
    ]
    assert [root._shared_id for root in page.shadow_roots("open")] == [
        "open-root-id",
    ]


def test_shadow_roots_rejects_invalid_mode():
    page, _driver = make_page(response=make_dom_response())

    with pytest.raises(ValueError, match="mode"):
        page.shadow_roots("invalid")


def test_shadow_roots_returns_empty_list_when_serialization_is_unsupported():
    page, _driver = make_page(
        error=BiDiError("invalid argument", "unsupported serialization option")
    )

    assert page.shadow_roots() == []
