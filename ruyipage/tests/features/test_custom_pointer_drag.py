# -*- coding: utf-8 -*-

import pytest


def _setup(page, fixture_page_url):
    page.set.viewport(800, 240)
    page.get(fixture_page_url("custom_pointer_drag.html"))
    page.wait.js_result("window.__ruyi_fixture_ready === true ? true : null", timeout=3)
    page.run_js("window.__customPointerDrag.reset()")


@pytest.mark.feature
def test_custom_pointer_drag_uses_pointer_capture_and_no_native_html5_drag(
    page, fixture_page_url
):
    _setup(page, fixture_page_url)

    handle = page.ele("#handle")
    target = page.ele("#target")

    page.actions.hold(handle).wait(0.05).human_move(target, style="line").wait(0.05).release().perform()
    page.wait.js_result(
        """
        const state = window.__customPointerDrag.state();
        return state.hitTarget === true &&
          state.offset >= 280 &&
          state.offset <= 300 &&
          state.events.some((event) => event.type === 'pointerup') &&
          state.captures.includes('lost') ? state : null;
        """,
        timeout=3,
    )

    state = page.run_js("return window.__customPointerDrag.state()")
    events = state["events"]
    down_index = next(
        index for index, event in enumerate(events) if event["type"] == "pointerdown"
    )
    pointer_id = events[down_index]["pointerId"]
    up_index = next(
        index
        for index, event in enumerate(events)
        if event["type"] == "pointerup" and event["pointerId"] == pointer_id
    )
    drag_events = [
        event
        for event in events[down_index : up_index + 1]
        if event["pointerId"] == pointer_id
    ]
    drag_moves = [event for event in drag_events if event["type"] == "pointermove"]

    assert state["hitTarget"] is True, state
    assert state["captures"] == ["got", "lost"], state
    assert 280 <= state["offset"] <= 300, state
    assert drag_moves, state
    assert all(event["buttons"] == 1 for event in drag_moves), state
    assert any(event["captured"] is True for event in drag_moves), state
    assert drag_events[0]["type"] == "pointerdown", state
    assert drag_events[0]["target"] == "handle", state
    assert drag_events[0]["buttons"] == 1, state
    assert drag_events[-1]["type"] == "pointerup", state
    assert any(event["type"] == "pointerup" and event["buttons"] == 0 for event in drag_events), state
