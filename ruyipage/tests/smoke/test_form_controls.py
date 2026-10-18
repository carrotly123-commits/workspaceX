# -*- coding: utf-8 -*-

import pytest


@pytest.mark.smoke
def test_form_controls_behave_correctly(page, fixture_page_url):
    page.get(fixture_page_url("form_controls.html"))

    text_input = page.ele("#text-input")
    text_input.input("before")
    text_input.clear()
    text_input.input("after")
    assert text_input.value == "after"

    page.ele("#email-input").input("demo@example.com")
    page.ele("#password-input").input("secret-123")
    page.ele("#textarea").input("line1\nline2")

    checkbox_a = page.ele("#checkbox-a")
    checkbox_a.click_self()
    assert checkbox_a.is_checked is True

    radio_a = page.ele("#radio-a")
    radio_b = page.ele("#radio-b")
    radio_a.click_self()
    assert radio_a.is_checked is True
    radio_b.click_self()
    assert radio_b.is_checked is True
    assert radio_a.is_checked is False

    select = page.ele("#select-single")
    selected = select.select.by_value("opt2", mode="native_only")
    if not selected:
        selected = select.select.by_value("opt2", mode="compat")
    assert selected is True
    assert select.value == "opt2"

    page.ele("#submit-btn").click_self()
    result_text = page.ele("#form-result").text
    assert '"text":"after"' in result_text
    assert '"select":"opt2"' in result_text
