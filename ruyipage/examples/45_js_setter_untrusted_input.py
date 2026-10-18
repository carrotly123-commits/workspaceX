# -*- coding: utf-8 -*-
"""示例45: 覆盖多种 JS 事件动作，并对比普通事件与 ruyi=true 的 isTrusted。"""

import io
import sys
from urllib.parse import quote


if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")


from ruyipage import launch


HTML = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>示例45 JS 事件 isTrusted 对比</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      padding: 24px;
      line-height: 1.6;
      background: #f6f8fb;
      color: #1f2937;
    }

    .wrap {
      max-width: 1100px;
      margin: 0 auto;
    }

    .panel {
      background: #fff;
      border: 1px solid #d8e1ee;
      border-radius: 14px;
      padding: 20px;
      margin-bottom: 18px;
      box-shadow: 0 6px 22px rgba(15, 23, 42, 0.05);
    }

    h1 {
      margin-top: 0;
      font-size: 28px;
    }

    p {
      margin: 6px 0;
    }

    .code {
      font-family: Consolas, monospace;
      font-size: 13px;
      background: #eef2f7;
      padding: 2px 6px;
      border-radius: 6px;
    }

    input,
    button,
    select {
      margin-top: 10px;
      margin-right: 8px;
      padding: 8px 12px;
      font-size: 14px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      background: #fff;
    }

    th,
    td {
      border-bottom: 1px solid #e5e7eb;
      padding: 10px 8px;
      text-align: left;
      vertical-align: top;
      font-size: 14px;
    }

    th {
      background: #f8fafc;
    }

    .ok {
      color: #166534;
      font-weight: 700;
    }

    .bad {
      color: #991b1b;
      font-weight: 700;
    }

    pre {
      margin: 0;
      background: #0f172a;
      color: #dbeafe;
      padding: 14px;
      border-radius: 12px;
      white-space: pre-wrap;
      font-family: Consolas, monospace;
      font-size: 13px;
      max-height: 320px;
      overflow: auto;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="panel">
      <h1>示例45: 多种 JS 事件 + isTrusted 对比</h1>
      <p>每个事件都做两次：一次普通构造，一次附加 <span class="code">ruyi: true</span>。</p>
      <p>示例目标是验证：<span class="code">new Event('change', { bubbles: true })</span> 与 <span class="code">new Event('change', { bubbles: true, ruyi: true })</span> 这类差异，是否会反映到 <span class="code">isTrusted</span>。</p>

      <input id="demo-input" value="initial" placeholder="input target">
      <button id="demo-button" type="button">button target</button>
      <select id="demo-select">
        <option value="one">one</option>
        <option value="two">two</option>
      </select>
    </div>

    <div class="panel">
      <table>
        <thead>
          <tr>
            <th>测试项</th>
            <th>构造代码</th>
            <th>预期</th>
            <th>实际</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody id="result-body"></tbody>
      </table>
    </div>

    <div class="panel">
      <pre id="log"></pre>
    </div>
  </div>

  <script>
    window.__ruyiCaseResults = [];

    const input = document.getElementById('demo-input');
    const button = document.getElementById('demo-button');
    const select = document.getElementById('demo-select');
    const body = document.getElementById('result-body');
    const logEl = document.getElementById('log');

    function log(message) {
      logEl.textContent += message + '\\n';
      console.log(message);
    }

    function setInputValue(value) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(input, value);
    }

    function addRow(item) {
      const tr = document.createElement('tr');
      const ok = item.expected === item.actual;
      tr.innerHTML =
        '<td>' + item.name + '</td>' +
        '<td><span class="code">' + item.code + '</span></td>' +
        '<td>' + item.expected + '</td>' +
        '<td>' + item.actual + '</td>' +
        '<td class="' + (ok ? 'ok' : 'bad') + '">' + (ok ? 'PASS' : 'FAIL') + '</td>';
      body.appendChild(tr);
    }

    function captureOnce(target, type, dispatch) {
      let captured = null;

      function handler(event) {
        captured = event.isTrusted;
      }

      target.addEventListener(type, handler, { once: true, capture: true });
      dispatch();
      return captured;
    }

    function runCase(item) {
      if (typeof item.before === 'function') {
        item.before();
      }

      const actual = captureOnce(item.target, item.type, function() {
        item.target.dispatchEvent(item.create());
      });

      const result = {
        name: item.name,
        code: item.code,
        expected: String(item.expected),
        actual: String(actual)
      };

      window.__ruyiCaseResults.push(result);
      addRow(result);
      log(
        '[' + result.name + '] expected=' + result.expected + ' actual=' + result.actual
      );
    }

    window.__runRuyiEventCases = function() {
      body.innerHTML = '';
      logEl.textContent = '';
      window.__ruyiCaseResults = [];

      const cases = [
        {
          name: 'Event / change / normal',
          target: input,
          type: 'change',
          expected: false,
          code: "new Event('change', { bubbles: true })",
          create: function() {
            return new Event('change', { bubbles: true });
          }
        },
        {
          name: 'Event / change / ruyi',
          target: input,
          type: 'change',
          expected: true,
          code: "new Event('change', { bubbles: true, ruyi: true })",
          create: function() {
            return new Event('change', { bubbles: true, ruyi: true });
          }
        },
        {
          name: 'InputEvent / input / normal',
          target: input,
          type: 'input',
          expected: false,
          code: "new InputEvent('input', { bubbles: true, data: 'A', inputType: 'insertText' })",
          before: function() {
            setInputValue('A');
          },
          create: function() {
            return new InputEvent('input', {
              bubbles: true,
              data: 'A',
              inputType: 'insertText'
            });
          }
        },
        {
          name: 'InputEvent / input / ruyi',
          target: input,
          type: 'input',
          expected: true,
          code: "new InputEvent('input', { bubbles: true, data: 'B', inputType: 'insertText', ruyi: true })",
          before: function() {
            setInputValue('B');
          },
          create: function() {
            return new InputEvent('input', {
              bubbles: true,
              data: 'B',
              inputType: 'insertText',
              ruyi: true
            });
          }
        },
        {
          name: 'KeyboardEvent / keydown / normal',
          target: input,
          type: 'keydown',
          expected: false,
          code: "new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' })",
          create: function() {
            return new KeyboardEvent('keydown', {
              bubbles: true,
              key: 'Enter',
              code: 'Enter'
            });
          }
        },
        {
          name: 'KeyboardEvent / keydown / ruyi',
          target: input,
          type: 'keydown',
          expected: true,
          code: "new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', ruyi: true })",
          create: function() {
            return new KeyboardEvent('keydown', {
              bubbles: true,
              key: 'Enter',
              code: 'Enter',
              ruyi: true
            });
          }
        },
        {
          name: 'MouseEvent / click / normal',
          target: button,
          type: 'click',
          expected: false,
          code: "new MouseEvent('click', { bubbles: true, clientX: 12, clientY: 24 })",
          create: function() {
            return new MouseEvent('click', {
              bubbles: true,
              clientX: 12,
              clientY: 24
            });
          }
        },
        {
          name: 'MouseEvent / click / ruyi',
          target: button,
          type: 'click',
          expected: true,
          code: "new MouseEvent('click', { bubbles: true, clientX: 12, clientY: 24, ruyi: true })",
          create: function() {
            return new MouseEvent('click', {
              bubbles: true,
              clientX: 12,
              clientY: 24,
              ruyi: true
            });
          }
        },
        {
          name: 'FocusEvent / focus / normal',
          target: input,
          type: 'focus',
          expected: false,
          code: "new FocusEvent('focus', { bubbles: false })",
          create: function() {
            return new FocusEvent('focus', { bubbles: false });
          }
        },
        {
          name: 'FocusEvent / focus / ruyi',
          target: input,
          type: 'focus',
          expected: true,
          code: "new FocusEvent('focus', { bubbles: false, ruyi: true })",
          create: function() {
            return new FocusEvent('focus', { bubbles: false, ruyi: true });
          }
        },
        {
          name: 'CustomEvent / ruyi-custom / normal',
          target: button,
          type: 'ruyi-custom',
          expected: false,
          code: "new CustomEvent('ruyi-custom', { bubbles: true, detail: { from: 'normal' } })",
          create: function() {
            return new CustomEvent('ruyi-custom', {
              bubbles: true,
              detail: { from: 'normal' }
            });
          }
        },
        {
          name: 'CustomEvent / ruyi-custom / ruyi',
          target: button,
          type: 'ruyi-custom',
          expected: true,
          code: "new CustomEvent('ruyi-custom', { bubbles: true, detail: { from: 'ruyi' }, ruyi: true })",
          create: function() {
            return new CustomEvent('ruyi-custom', {
              bubbles: true,
              detail: { from: 'ruyi' },
              ruyi: true
            });
          }
        },
        {
          name: 'PointerEvent / pointerdown / normal',
          target: button,
          type: 'pointerdown',
          expected: false,
          code: "new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 3, clientY: 5 })",
          create: function() {
            return new PointerEvent('pointerdown', {
              bubbles: true,
              pointerId: 1,
              clientX: 3,
              clientY: 5
            });
          }
        },
        {
          name: 'PointerEvent / pointerdown / ruyi',
          target: button,
          type: 'pointerdown',
          expected: true,
          code: "new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 3, clientY: 5, ruyi: true })",
          create: function() {
            return new PointerEvent('pointerdown', {
              bubbles: true,
              pointerId: 1,
              clientX: 3,
              clientY: 5,
              ruyi: true
            });
          }
        },
        {
          name: 'WheelEvent / wheel / normal',
          target: input,
          type: 'wheel',
          expected: false,
          code: "new WheelEvent('wheel', { bubbles: true, deltaY: 120 })",
          create: function() {
            return new WheelEvent('wheel', {
              bubbles: true,
              deltaY: 120
            });
          }
        },
        {
          name: 'WheelEvent / wheel / ruyi',
          target: input,
          type: 'wheel',
          expected: true,
          code: "new WheelEvent('wheel', { bubbles: true, deltaY: 120, ruyi: true })",
          create: function() {
            return new WheelEvent('wheel', {
              bubbles: true,
              deltaY: 120,
              ruyi: true
            });
          }
        },
        {
          name: 'Event / change / select normal',
          target: select,
          type: 'change',
          expected: false,
          code: "new Event('change', { bubbles: true }) // select",
          before: function() {
            select.value = 'two';
          },
          create: function() {
            return new Event('change', { bubbles: true });
          }
        },
        {
          name: 'Event / change / select ruyi',
          target: select,
          type: 'change',
          expected: true,
          code: "new Event('change', { bubbles: true, ruyi: true }) // select",
          before: function() {
            select.value = 'one';
          },
          create: function() {
            return new Event('change', { bubbles: true, ruyi: true });
          }
        }
      ];

      for (let i = 0; i < cases.length; i += 1) {
        runCase(cases[i]);
      }

      return window.__ruyiCaseResults;
    };
  </script>
</body>
</html>
"""


def main():
    page = launch(headless=False, window_size=(1500, 950))
    try:
        page.get("data:text/html;charset=utf-8," + quote(HTML))
        page.wait.doc_loaded(timeout=10)

        results = page.run_js("return window.__runRuyiEventCases()", as_expr=False)
        results = results if isinstance(results, list) else []

        print("=" * 88)
        print("示例45: 各种 JS 事件动作 + ruyi 扩展属性，对比 isTrusted")
        print("页面标题:", page.title)
        print("测试总数:", len(results))
        print()

        pass_count = 0
        normal_failures = []
        ruyi_failures = []

        for item in results:
            name = item.get("name", "")
            expected = item.get("expected")
            actual = item.get("actual")
            ok = expected == actual
            if ok:
                pass_count += 1
            elif " / ruyi" in name:
                ruyi_failures.append(name)
            else:
                normal_failures.append(name)

            print(
                "[{status}] {name}\n"
                "  code     : {code}\n"
                "  expected : {expected}\n"
                "  actual   : {actual}".format(
                    status="PASS" if ok else "FAIL",
                    name=name,
                    code=item.get("code", ""),
                    expected=expected,
                    actual=actual,
                )
            )

        print()
        print("汇总:")
        print("  通过: {}/{}".format(pass_count, len(results)))
        print("  普通事件失败数:", len(normal_failures))
        print("  ruyi=true 事件失败数:", len(ruyi_failures))

        if normal_failures:
            print("  普通事件失败项:", ", ".join(normal_failures))
        if ruyi_failures:
            print("  ruyi=true 失败项:", ", ".join(ruyi_failures))

        print()
        if pass_count == len(results):
            print(
                "结论: 普通 JS 事件与 ruyi=true 事件的 isTrusted 对比，全部符合预期。"
            )
        else:
            print("结论: 存在与预期不一致的 isTrusted 结果，请结合页面表格继续核对。")

        page.wait(1.5)
    finally:
        page.quit()


if __name__ == "__main__":
    main()
