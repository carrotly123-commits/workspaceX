# -*- coding: utf-8 -*-

import pytest


@pytest.mark.smoke
@pytest.mark.local_server
def test_navigation_to_local_server_page(page, server):
    page.get(server.get_url("/nav/basic"))
    assert page.title == "Nav Basic"
    assert page.ele("#nav-basic").text == "Nav Basic"


@pytest.mark.smoke
def test_navigation_to_local_fixture_page(page, fixture_page_url):
    page.get(fixture_page_url("basic_form.html"))
    assert page.title == "Basic Form"
    assert page.ele("#page-title").text == "Basic Form"


@pytest.mark.smoke
@pytest.mark.local_server
def test_navigation_back_and_forward(page, server):
    page.get(server.get_url("/nav/basic"))
    page.get(server.get_url("/nav/history"))
    assert page.title == "Nav History"

    page.back()
    page.wait(0.5)
    assert page.title == "Nav Basic"

    page.forward()
    page.wait(0.5)
    assert page.title == "Nav History"
