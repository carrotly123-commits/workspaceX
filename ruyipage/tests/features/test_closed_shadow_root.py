# -*- coding: utf-8 -*-

from types import SimpleNamespace

from ruyipage._elements.firefox_element import FirefoxElement
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


def make_element(response=None, error=None):
    browser_driver = FakeBrowserDriver(response=response, error=error)
    owner = SimpleNamespace(
        _context_id="ctx-1",
        _driver=SimpleNamespace(_browser_driver=browser_driver),
    )
    element = FirefoxElement(
        owner,
        "host-shared-id",
        "host-handle",
        {"localName": "div", "attributes": {"id": "host"}},
    )
    return element, browser_driver


def test_closed_shadow_root_uses_native_serialization_without_page_bridge():
    element, driver = make_element(
        response={
            "type": "success",
            "result": {
                "type": "node",
                "sharedId": "host-shared-id",
                "value": {
                    "nodeType": 1,
                    "localName": "div",
                    "shadowRoot": {
                        "type": "node",
                        "sharedId": "closed-shadow-id",
                        "value": {
                            "nodeType": 11,
                            "mode": "closed",
                            "childNodeCount": 1,
                        },
                    },
                },
            },
        }
    )

    root = element.closed_shadow_root

    assert isinstance(root, FirefoxElement)
    assert root._shared_id == "closed-shadow-id"
    assert root._node_info["mode"] == "closed"

    method, params, timeout = driver.calls[0]
    assert method == "script.callFunction"
    assert timeout is None
    assert params["target"] == {"context": "ctx-1"}
    assert params["arguments"] == [
        {
            "type": "sharedReference",
            "sharedId": "host-shared-id",
            "handle": "host-handle",
        }
    ]
    assert params["serializationOptions"] == {"maxDomDepth": 1}
    assert "__ruyiGetClosedShadowRoot" not in params["functionDeclaration"]


def test_closed_shadow_root_ignores_open_shadow_root_from_native_serialization():
    element, _driver = make_element(
        response={
            "type": "success",
            "result": {
                "type": "node",
                "sharedId": "host-shared-id",
                "value": {
                    "nodeType": 1,
                    "localName": "div",
                    "shadowRoot": {
                        "type": "node",
                        "sharedId": "open-shadow-id",
                        "value": {"nodeType": 11, "mode": "open"},
                    },
                },
            },
        }
    )

    assert element.closed_shadow_root is None


def test_closed_shadow_root_returns_none_when_native_serialization_is_unsupported():
    element, _driver = make_element(
        error=BiDiError("invalid argument", "unsupported serialization option")
    )

    assert element.closed_shadow_root is None
