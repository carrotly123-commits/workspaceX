# -*- coding: utf-8 -*-
"""Issue #16 regression tests for chained action ordering."""

import pytest


def _setup_email(page, fixture_page_url):
    page.set.viewport(1280, 900)
    page.get(fixture_page_url("basic_form.html"))
    page.run_js("window.__resetEmailEvents()")
    return page.ele("#email-input")


def _email_value(page):
    return page.run_js("return document.getElementById('email-input').value")


def _email_events(page):
    return page.run_js("return window.__emailEvents")


def _active_element_id(page):
    return page.run_js("return document.activeElement && document.activeElement.id")


def _first_event_index(events, event_type):
    for index, event in enumerate(events):
        if event["type"] == event_type:
            return index
    return -1


@pytest.mark.feature
def test_move_click_type_runs_keys_after_focus_and_click(page, fixture_page_url):
    email = _setup_email(page, fixture_page_url)

    page.actions.move_to(email).click().type("123").perform()
    page.wait(0.2)

    events = _email_events(page)
    click_index = _first_event_index(events, "click")
    keydown_index = _first_event_index(events, "keydown")

    assert _email_value(page) == "123"
    assert _active_element_id(page) == "email-input"
    assert click_index != -1
    assert keydown_index != -1
    assert click_index < keydown_index


@pytest.mark.feature
def test_human_move_click_human_type_inputs_full_text(page, fixture_page_url):
    email = _setup_email(page, fixture_page_url)

    page.actions.human_move(email, style="line").human_click().human_type("123").perform()
    page.wait(0.2)

    assert _email_value(page) == "123"


@pytest.mark.feature
def test_wait_between_click_and_type_delays_keydown(page, fixture_page_url):
    email = _setup_email(page, fixture_page_url)

    page.actions.move_to(email).click().wait(0.2).type("x").perform()
    page.wait(0.2)

    events = _email_events(page)
    click_events = [event for event in events if event["type"] == "click"]
    keydown_events = [event for event in events if event["type"] == "keydown"]

    assert _email_value(page) == "x"
    assert click_events
    assert keydown_events

    delay = keydown_events[0]["time"] - click_events[0]["time"]
    assert delay >= 150
