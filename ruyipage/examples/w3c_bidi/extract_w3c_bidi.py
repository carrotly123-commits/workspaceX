#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从W3C WebDriver BiDi规范网页提取所有API（使用正确的选择器）"""

import sys
import io
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from ruyipage import *
import re

# 创建浏览器
page = FirefoxPage()

try:
    print("正在访问 W3C WebDriver BiDi 规范...")
    page.get('https://w3c.github.io/webdriver-bidi/')

    print("等待页面加载...")
    page.wait(3)

    print("\n从目录 (ol.toc li a) 提取所有API...")

    # 提取目录中的所有链接
    toc_script = """
    (() => {
        const items = [];
        document.querySelectorAll('ol.toc li a').forEach(link => {
            const href = link.getAttribute('href');
            const text = link.textContent.trim();
            if (href && text) {
                items.push({
                    href: href,
                    text: text,
                    id: href.replace('#', '')
                });
            }
        });
        return items;
    })()
    """

    toc_items = page.run_js(toc_script)

    print(f"\n找到 {len(toc_items)} 个目录项")

    # 分析提取命令和事件
    commands = {}
    events = {}
    modules = set()

    for item in toc_items:
        text = item['text']
        id_str = item['id']

        # 提取命令（格式：The module.command Command）
        cmd_match = re.search(r'The\s+(\w+)\.(\w+)\s+Command', text)
        if cmd_match:
            module = cmd_match.group(1)
            cmd_name = f"{module}.{cmd_match.group(2)}"
            modules.add(module)
            if module not in commands:
                commands[module] = []
            commands[module].append(cmd_name)
            print(f"  命令: {cmd_name}")

        # 提取事件（格式：The module.event Event）
        evt_match = re.search(r'The\s+(\w+)\.(\w+)\s+Event', text)
        if evt_match:
            module = evt_match.group(1)
            evt_name = f"{module}.{evt_match.group(2)}"
            modules.add(module)
            if module not in events:
                events[module] = []
            events[module].append(evt_name)
            print(f"  事件: {evt_name}")

    print(f"\n\n=== 统计结果 ===")
    print(f"模块数: {len(modules)}")
    print(f"命令数: {sum(len(v) for v in commands.values())}")
    print(f"事件数: {sum(len(v) for v in events.values())}")

    print("\n\n=== 按模块分类的命令 ===")
    for module in sorted(commands.keys()):
        print(f"\n{module} 模块 ({len(commands[module])} 个命令):")
        for cmd in sorted(commands[module]):
            print(f"  - {cmd}")

    print("\n\n=== 按模块分类的事件 ===")
    for module in sorted(events.keys()):
        print(f"\n{module} 模块 ({len(events[module])} 个事件):")
        for evt in sorted(events[module]):
            print(f"  - {evt}")

    # 保存结构化数据
    import json
    result = {
        'modules': sorted(list(modules)),
        'commands': commands,
        'events': events,
        'total_commands': sum(len(v) for v in commands.values()),
        'total_events': sum(len(v) for v in events.values())
    }

    with open('E:/ruyipage/w3c_bidi_apis.json', 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print("\n\n结构化数据已保存到: E:/ruyipage/w3c_bidi_apis.json")

finally:
    page.quit()
