# -*- coding: utf-8 -*-

import pytest

from ruyipage import FirefoxPage


@pytest.mark.integration
@pytest.mark.local_server
def test_cookie_and_storage_reuse_with_user_dir(opts_factory, server, temp_user_dir):
    page = FirefoxPage(opts_factory(user_dir=temp_user_dir))
    try:
        page.get(server.get_url("/storage/page"))
        page.local_storage.set("persist_token", "token-001")
        page.session_storage.set("transient_state", "ready")

        assert page.local_storage.get("persist_token") == "token-001"
        assert page.session_storage.get("transient_state") == "ready"

        page.get(server.get_url("/set-cookie"))
        page.get(server.get_url("/get-cookie"))
        body_text = page.ele("tag:body").text
        assert "server_cookie=server_value" in body_text

        page.get(server.get_url("/storage/page"))
        assert page.local_storage.get("persist_token") == "token-001"
    finally:
        page.quit()
