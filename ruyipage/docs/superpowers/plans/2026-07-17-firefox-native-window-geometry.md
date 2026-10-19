# Firefox Native Window Geometry Implementation Plan

> **2026-07-18 audit amendment:** `set_window_size_on_opts` is retained only as
> a deprecated no-op. Fingerprint `screen.*` dimensions must never be mapped to
> the Firefox outer window; callers that need an outer window must invoke
> `FirefoxOptions.set_window_size()` explicitly.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让智能指纹默认不再修改 Firefox 窗口几何，同时强化 BiDi 拖拽的按压连续性和目标指纹浏览器 16/93 原生几何回归。

**Architecture:** 指纹构建层只生成和加载 fpfile，不再把屏幕指纹映射成外部窗口尺寸；窗口、viewport 和 screen API 仅在用户显式调用时生效。拖拽继续使用单次 `input.performActions`，通过 pointer capture 和 TikTok 风格自定义拖拽页面做黑盒验证。

**Tech Stack:** Python 3.9+、pytest、Firefox WebDriver BiDi、HTML/JavaScript 测试 fixture。

**Constraint:** 不执行 `git commit`，保留用户现有未跟踪文件。

---

### Task 1: Remove Implicit Fingerprint Window Sizing

**Files:**
- Modify: `tests/test_fingerprint_builder.py:618`
- Modify: `tests/test_fingerprint_builder.py:652`
- Modify: `ruyipage/_fingerprint/builder.py:1458`
- Modify: `ruyipage/_fingerprint/builder.py:1497`
- Modify: `ruyipage/_fingerprint/builder.py:1656`

- [ ] **Step 1: Replace the default-window expectation with a failing native-geometry test**

```python
def _make_1366_fingerprint():
    hw = next(p for p in list_hardware_profiles() if p.id == "win-hd4600")
    country = get_country_profile("US")
    return FingerprintProfile(
        profile_id=hw.id,
        firefox_version=152,
        useragent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) "
            "Gecko/20100101 Firefox/152.0"
        ),
        hardware=hw,
        country=country,
        canvas_seed=175,
        language_primary=country.language_primary,
        accept_language=country.accept_language,
    )


def test_apply_smart_fingerprint_does_not_set_window_size_by_default(tmp_path):
    geo = _make_geo()
    fp = _make_1366_fingerprint()

    with mock.patch.object(builder, "fetch_geo_info", return_value=geo), \
            mock.patch.object(builder, "fetch_public_ipv6", return_value=None), \
            mock.patch.object(builder, "pick_fingerprint", return_value=fp):
        opts = _StubOptions()
        ctx = apply_smart_fingerprint(
            opts,
            base_dir=str(tmp_path),
            require_country="US",
            fetch_ipv6=False,
        )

    text = open(ctx.fpfile_path, encoding="utf-8").read()
    assert "width:1366\n" not in text
    assert "height:768\n" not in text
    assert "set_window_size" not in [call[0] for call in opts.calls]
```

- [ ] **Step 2: Add a failing explicit-compatibility test**

```python
def test_apply_smart_fingerprint_sets_raw_window_size_when_explicit(tmp_path):
    geo = _make_geo()
    fp = _make_1366_fingerprint()
    with mock.patch.object(builder, "fetch_geo_info", return_value=geo), \
            mock.patch.object(builder, "fetch_public_ipv6", return_value=None), \
            mock.patch.object(builder, "pick_fingerprint", return_value=fp):
        opts = _StubOptions()
        apply_smart_fingerprint(
            opts,
            base_dir=str(tmp_path),
            require_country="US",
            fetch_ipv6=False,
            set_window_size_on_opts=True,
        )
    assert "set_window_size" not in [call[0] for call in opts.calls]
```

- [ ] **Step 3: Run the two tests and verify RED**

Run: `python -m pytest tests/test_fingerprint_builder.py -k "window_size" -q`

Expected: the default test fails because `set_window_size()` is still called; the explicit test fails because the current implementation passes a reduced size.

- [ ] **Step 4: Implement the minimal native behavior**

Delete `_safe_startup_window_size()`, change the existing parameter declaration from `True` to `False`, and replace the call site with:

```python
set_window_size_on_opts: bool = False,

if set_window_size_on_opts:
    try:
        log("[fp] set_window_size_on_opts is deprecated and ignored")
```

- [ ] **Step 5: Run focused fingerprint tests and verify GREEN**

Run: `python -m pytest tests/test_fingerprint_builder.py -q`

Expected: all fingerprint builder tests pass.

- [ ] **Step 6: Inspect the diff without committing**

Run: `git diff -- ruyipage/_fingerprint/builder.py tests/test_fingerprint_builder.py`

Expected: only the implicit sizing behavior and its tests changed.

---

### Task 2: Document the Native Default and Migration Path

**Files:**
- Modify: `README.md:1720`
- Modify: `README_EN.md`
- Modify: `ruyipage/_fingerprint/README.md:1`
- Modify: `examples/48_smart_fingerprint.py:1`
- Modify: `ruyipage/_fingerprint/builder.py:11`
- Test: `tests/async_smoke/test_async_baseline.py`

- [ ] **Step 1: Add a failing documentation contract test**

Add to an existing fast documentation/API drift test module:

```python
def test_smart_fingerprint_docs_describe_native_window_default():
    root = Path(__file__).resolve().parents[2]
    readme = (root / "README.md").read_text(encoding="utf-8")
    readme_en = (root / "README_EN.md").read_text(encoding="utf-8")
    fp_readme = (root / "ruyipage/_fingerprint/README.md").read_text(encoding="utf-8")
    example = (root / "examples/48_smart_fingerprint.py").read_text(encoding="utf-8")
    builder_doc = (root / "ruyipage/_fingerprint/builder.py").read_text(encoding="utf-8")
    firefox_options_doc = (root / "ruyipage/_configs/firefox_options.py").read_text(encoding="utf-8")
    design_doc = (root / "docs/superpowers/specs/2026-07-17-firefox-native-window-geometry-design.md").read_text(encoding="utf-8")
    plan_doc = (root / "docs/superpowers/plans/2026-07-17-firefox-native-window-geometry.md").read_text(encoding="utf-8")
    combined_docs = "\n".join(
        [readme, readme_en, fp_readme, example, builder_doc, firefox_options_doc, design_doc, plan_doc]
    )
    assert "apply_smart_fingerprint 默认不设置外部窗口" in combined_docs
    assert "ctx = opts.smart_fingerprint(...) -> page = FirefoxPage(opts) -> ctx.apply_emulation(page)" in combined_docs
    assert "set_window_size_on_opts 仅为兼容保留且已忽略" in combined_docs
    assert "删除字段，创建后screen override" in combined_docs
    assert "apply_emulation(page) 返回的结果包含 screen" in combined_docs
```

- [ ] **Step 2: Run the documentation test and verify RED**

Run: `python -m pytest tests/async_smoke/test_async_baseline.py -k smart_fingerprint_docs -q`

Expected: FAIL because the migration wording is absent.

- [ ] **Step 3: Update public documentation and example**

Document these exact rules:

```python
# Native default: fpfile only, Firefox owns window geometry.
ctx = opts.smart_fingerprint(
    proxy_host='127.0.0.1',
    proxy_port=8080,
)

# Explicit legacy-style outer-window request.
ctx = opts.smart_fingerprint(
    proxy_host='127.0.0.1',
    proxy_port=8080,
    # set_window_size_on_opts is deprecated and ignored
)
```

Remove wording that claims smart fingerprint always configures window size. State that
`set_window_size_on_opts` is a deprecated no-op, and `fpfile` no longer stores
`width` / `height`. Explicit outer-window sizing uses `opts.set_window_size()`.

- [ ] **Step 4: Run the documentation/API test and verify GREEN**

Run: `python -m pytest tests/async_smoke/test_async_baseline.py -k smart_fingerprint_docs -q`

Expected: PASS.

- [ ] **Step 5: Search for stale behavior claims**

Run: `rg -n "safe startup|自动.*window_size|set_window_size_on_opts|window size" README.md README_EN.md ruyipage/_fingerprint examples/48_smart_fingerprint.py`

Expected: every remaining claim matches the native default.

---

### Task 3: Strengthen Pointer Drag Browser Semantics

**Files:**
- Modify: `tests/fixtures/pages/drag_slider.html:1`
- Modify: `tests/features/test_actions.py:171`
- Test: `tests/test_actions_drag_staging.py`
- Verify: `ruyipage/_units/actions.py:482`

- [ ] **Step 1: Extend the drag fixture event state**

Record complete pointer state:

```javascript
const state = {
  events: [],
  captures: [],
  left: 0,
};

function record(event) {
  state.events.push({
    type: event.type,
    buttons: event.buttons,
    clientX: event.clientX,
    target: event.target.id,
  });
}

knob.addEventListener('gotpointercapture', () => state.captures.push('got'));
knob.addEventListener('lostpointercapture', () => state.captures.push('lost'));
```

- [ ] **Step 2: Tighten the browser test so it initially fails**

```python
state = page.run_js("return window.__dragSlider.state()")
down_index = next(i for i, event in enumerate(state["events"]) if event["type"] == "pointerdown")
up_index = next(i for i, event in enumerate(state["events"]) if event["type"] == "pointerup")
drag_moves = [
    event for event in state["events"][down_index + 1:up_index]
    if event["type"] == "pointermove"
]

assert state["events"][down_index]["buttons"] == 1
assert drag_moves
assert all(event["buttons"] == 1 for event in drag_moves)
assert state["events"][up_index]["buttons"] == 0
assert state["captures"] == ["got", "lost"]
assert state["left"] >= 250
```

- [ ] **Step 3: Replace fixed sleep with condition polling**

Use the existing waiter API rather than relying on `page.wait(0.3)`:

```python
assert page.wait.js_result(
    "return window.__dragSlider.state().left >= 250",
    timeout=3,
)
```

- [ ] **Step 4: Run the browser drag test**

Run: `python -m pytest tests/features/test_actions.py -k waited_human_drag -m browser -q`

Expected before fixture update: FAIL due to missing event/capture state. Expected after fixture update: PASS without production changes if the existing atomic drag implementation is correct.

- [ ] **Step 5: Re-run white-box staging tests**

Run: `python -m pytest tests/test_actions_drag_staging.py -q`

Expected: PASS; one pointer action source contains `pointerDown`, waits/moves, then `pointerUp`.

---

### Task 4: Add TikTok-Style Custom Drag Regression

**Files:**
- Create: `tests/fixtures/pages/custom_pointer_drag.html`
- Create: `tests/features/test_custom_pointer_drag.py`
- Modify: `tests/conftest.py`

- [ ] **Step 1: Create a custom pointer-drag fixture**

The fixture must not use iframe, HTML5 `draggable`, or `dataTransfer`. It should:

```javascript
handle.addEventListener('pointerdown', event => {
  dragging = true;
  startX = event.clientX;
  handle.setPointerCapture(event.pointerId);
  events.push({type: event.type, buttons: event.buttons});
});

handle.addEventListener('pointermove', event => {
  if (!dragging || event.buttons !== 1) return;
  offset = Math.max(0, Math.min(300, event.clientX - startX));
  handle.style.transform = `translateX(${offset}px)`;
  events.push({type: event.type, buttons: event.buttons});
});

handle.addEventListener('pointerup', event => {
  dragging = false;
  events.push({type: event.type, buttons: event.buttons});
  handle.releasePointerCapture(event.pointerId);
});
```

Expose `window.__customDrag.state()` with `offset`, `events`, and capture events.

- [ ] **Step 2: Write the browser test**

```python
@pytest.mark.feature
@pytest.mark.browser
def test_custom_pointer_drag_keeps_primary_button_pressed(page, fixture_page_url):
    page.get(fixture_page_url("custom_pointer_drag.html"))
    handle = page.ele("#handle")
    target = page.ele("#target")

    page.actions.hold(handle).wait(0.12).human_move(target, style="line").wait(0.08).release().perform()

    assert page.wait.js_result(
        "return window.__customDrag.state().offset >= 280",
        timeout=3,
    )
    state = page.run_js("return window.__customDrag.state()")
    moves = [event for event in state["events"] if event["type"] == "pointermove"]
    assert moves
    assert all(event["buttons"] == 1 for event in moves)
    assert state["events"][-1] == {"type": "pointerup", "buttons": 0}
    assert state["captures"] == ["got", "lost"]
```

- [ ] **Step 3: Register the test as a browser feature test**

Add `tests/features/test_custom_pointer_drag.py` to `BROWSER_TEST_FILES` in `tests/conftest.py` if fixture-based auto-detection does not already mark it.

- [ ] **Step 4: Run the custom drag test**

Run: `python -m pytest tests/features/test_custom_pointer_drag.py -m browser -q`

Expected: PASS with the current coalesced pointer drag; if it fails, inspect the single `input.performActions` payload before changing production code.

---

### Task 5: Add Target Fingerprint Firefox Geometry Verification

**Files:**
- Create: `tests/features/test_fingerprint_window_geometry.py`
- Modify: `tests/conftest.py`
- Modify: `tests/README.md`

- [ ] **Step 1: Add an opt-in target-runtime test**

```python
@pytest.mark.feature
@pytest.mark.browser
def test_target_firefox_uses_native_16_by_93_window_chrome(page):
    if os.environ.get("RUYIPAGE_VERIFY_NATIVE_GEOMETRY") != "1":
        pytest.skip("set RUYIPAGE_VERIFY_NATIVE_GEOMETRY=1 for target fingerprint Firefox")

    page.get("about:blank")
    metrics = page.run_js(
        """
        return {
          outerWidth: window.outerWidth,
          outerHeight: window.outerHeight,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          screenWidth: screen.width,
          screenHeight: screen.height,
          availWidth: screen.availWidth,
          availHeight: screen.availHeight,
          dpr: window.devicePixelRatio
        };
        """,
        as_expr=False,
    )

    assert metrics["outerWidth"] - metrics["innerWidth"] == 16, metrics
    assert metrics["outerHeight"] - metrics["innerHeight"] == 93, metrics
```

- [ ] **Step 2: Document the exact verification command**

Add to `tests/README.md`:

```powershell
$env:RUYIPAGE_TEST_FIREFOX_PATH='C:\path\to\fingerprint-firefox\firefox.exe'
$env:RUYIPAGE_VERIFY_NATIVE_GEOMETRY='1'
python -m pytest tests/features/test_fingerprint_window_geometry.py -m browser -q
```

State that failure reports raw metrics and must not trigger automatic coordinate compensation.

- [ ] **Step 3: Run collection without the target runtime**

Run: `python -m pytest tests/features/test_fingerprint_window_geometry.py -m browser -q`

Expected: one skipped test unless `RUYIPAGE_VERIFY_NATIVE_GEOMETRY=1` is set.

- [ ] **Step 4: Run against the target fingerprint Firefox when available**

Run the documented PowerShell command.

Expected: PASS with width delta 16 and height delta 93. If unavailable, record the test as not executed rather than claiming target-runtime verification.

---

### Task 6: Final Regression and Review

**Files:**
- Verify all modified files
- Preserve: `tests/verify_cebwm_runtime_*.js`

- [ ] **Step 1: Run focused fast tests**

Run: `python -m pytest -q tests/test_fingerprint_builder.py tests/test_actions_drag_staging.py tests/test_window_manager_set_size_sync.py tests/test_window_size_natural.py`

Expected: all pass.

- [ ] **Step 2: Run the full fast suite**

Run: `python -m pytest -m fast -q`

Expected: all fast tests pass; the existing `.pytest_cache` warning may remain.

- [ ] **Step 3: Compile the package**

Run: `python -m compileall -q ruyipage`

Expected: exit code 0.

- [ ] **Step 4: Review the complete diff**

Run: `git diff --check; git diff --stat; git status --short`

Expected: no whitespace errors; only planned files plus the pre-existing untracked verification scripts are present.

- [ ] **Step 5: Request final specialist review**

Ask reviewers to verify:

- no implicit smart-fingerprint window mutation remains;
- explicit window APIs retain their semantics;
- no 16/93 production compensation was introduced;
- drag tests verify all pressed moves and pointer capture;
- documentation describes the breaking default change.
