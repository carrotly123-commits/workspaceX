# -*- coding: utf-8 -*-

import pytest

from ruyipage import FirefoxPage, attach


@pytest.mark.feature
def test_attach_can_reuse_existing_browser(opts_factory):
    owner_page = FirefoxPage(opts_factory(close_on_exit=False))
    attached_page = None
    try:
        owner_page.get("about:blank")
        address = owner_page.browser.address

        attached_page = attach(address)
        attached_page.get("about:blank")

        assert attached_page.browser.address == address
        assert attached_page.url == "about:blank"
        assert attached_page.browser is owner_page.browser
    finally:
        try:
            if attached_page is not None:
                attached_page.quit()
        except Exception:
            pass
        try:
            owner_page.quit()
        except Exception:
            pass
