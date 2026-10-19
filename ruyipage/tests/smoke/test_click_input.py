# -*- coding: utf-8 -*-

import pytest

from ruyipage._functions.bidi_values import parse_value


def _bidi_caret_state(page, selector):
    result = page._driver.run(
        "script.evaluate",
        {
            "expression": """
            (() => {
              const input = document.querySelector(%r);
              return {
                exists: Boolean(input),
                focused: document.activeElement === input,
                value: input ? input.value : null,
                selectionStart: input ? input.selectionStart : null,
                selectionEnd: input ? input.selectionEnd : null
              };
            })()
            """ % selector,
            "awaitPromise": True,
            "resultOwnership": "none",
        },
    )
    return parse_value(result.get("result", {}))


@pytest.mark.smoke
def test_click_and_input_on_fixture_page(page, fixture_page_url):
    page.get(fixture_page_url("basic_form.html"))

    page.ele("#click-btn").click_self()
    assert page.ele("#click-result").text == "clicked"

    input_ele = page.ele("#text-input")
    input_ele.input("hello smoke")
    page.ele("#mirror-btn").click_self()
    assert input_ele.value == "hello smoke"
    assert page.ele("#mirror").text == "hello smoke"


@pytest.mark.smoke
def test_text_input_click_shows_caret(page, fixture_page_url):
    page.get(fixture_page_url("basic_form.html"))

    page.ele("#text-input").click_self()
    caret_state = page.run_js(
        """
        const input = document.querySelector('#text-input');
        return {
          focused: document.activeElement === input,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd
        };
        """,
        as_expr=False,
    )

    assert caret_state == {
        "focused": True,
        "selectionStart": 0,
        "selectionEnd": 0,
    }


@pytest.mark.smoke
def test_multiple_text_inputs_have_bidi_caret_after_click_and_input(page, fixture_page_url):
    page.get(fixture_page_url("basic_form.html"))

    scenarios = [
        ("#text-input", "alpha", 5),
        ("#email-input", "beta@example.test", 17),
        ("#search-input", "gamma query", 11),
        ("#textarea-input", "delta line", 10),
    ]

    for selector, text, expected_caret in scenarios:
        element = page.ele(selector)

        element.click_self()
        clicked_state = _bidi_caret_state(page, selector)
        assert clicked_state["exists"] is True
        assert clicked_state["focused"] is True
        assert clicked_state["selectionStart"] == clicked_state["selectionEnd"]

        element.input(text)
        typed_state = _bidi_caret_state(page, selector)

        assert typed_state == {
            "exists": True,
            "focused": True,
            "value": text,
            "selectionStart": expected_caret,
            "selectionEnd": expected_caret,
        }
