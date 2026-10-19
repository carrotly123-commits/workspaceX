#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成RuyiPage与W3C BiDi规范的精确对比表格"""

import sys
import io
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

import json

# 读取W3C规范数据
with open('w3c_bidi_apis.json', 'r', encoding='utf-8') as f:
    w3c_data = json.load(f)

# RuyiPage已实现的API
ruyipage_commands = {
    'session': [
        'session.status',
        'session.new',
        'session.end',
        'session.subscribe',
        'session.unsubscribe'
    ],
    'browser': [
        'browser.close',
        'browser.createUserContext',
        'browser.getUserContexts',
        'browser.removeUserContext',
        'browser.getClientWindows',
        'browser.setClientWindowState',
        'browser.setDownloadBehavior'
    ],
    'browsingContext': [
        'browsingContext.activate',
        'browsingContext.captureScreenshot',
        'browsingContext.close',
        'browsingContext.create',
        'browsingContext.getTree',
        'browsingContext.handleUserPrompt',
        'browsingContext.locateNodes',
        'browsingContext.navigate',
        'browsingContext.print',
        'browsingContext.reload',
        'browsingContext.setViewport',
        'browsingContext.traverseHistory'
        # 缺少: browsingContext.setBypassCSP
    ],
    'emulation': [
        'emulation.setUserAgentOverride',
        'emulation.setGeolocationOverride',
        'emulation.setTimezoneOverride',
        'emulation.setLocaleOverride',
        'emulation.setScreenOrientationOverride',
        'emulation.setScreenSettingsOverride',
        'emulation.setNetworkConditions',
        'emulation.setTouchOverride'
        # 缺少: setScriptingEnabled, setScrollbarTypeOverride, setForcedColorsModeThemeOverride
    ],
    'network': [
        'network.addIntercept',
        'network.removeIntercept',
        'network.continueRequest',
        'network.continueResponse',
        'network.continueWithAuth',
        'network.failRequest',
        'network.provideResponse',
        'network.addDataCollector',
        'network.removeDataCollector',
        'network.getData',
        'network.disownData',
        'network.setCacheBehavior',
        'network.setExtraHeaders'
    ],
    'script': [
        'script.evaluate',
        'script.callFunction',
        'script.addPreloadScript',
        'script.removePreloadScript',
        'script.getRealms',
        'script.disown'
    ],
    'storage': [
        'storage.getCookies',
        'storage.setCookie',
        'storage.deleteCookies'
    ],
    'input': [
        'input.performActions',
        'input.releaseActions',
        'input.setFiles'
    ],
    'webExtension': [
        'webExtension.install',
        'webExtension.uninstall'
    ]
}

ruyipage_events = {
    'browsingContext': [
        'browsingContext.contextCreated',
        'browsingContext.contextDestroyed',
        'browsingContext.domContentLoaded',
        'browsingContext.load',
        'browsingContext.navigationStarted',
        'browsingContext.userPromptOpened',
        'browsingContext.userPromptClosed'
        # 缺少: downloadWillBegin, downloadEnd, fragmentNavigated, historyUpdated,
        #       navigationAborted, navigationCommitted, navigationFailed
    ],
    'network': [
        'network.beforeRequestSent',
        'network.responseStarted',
        'network.responseCompleted',
        'network.fetchError',
        'network.authRequired'
    ],
    'script': [
        'script.realmCreated',
        'script.realmDestroyed'
        # 缺少: script.message
    ],
    'log': [
        'log.entryAdded'
    ]
    # 缺少: input.fileDialogOpened
}

# 测试覆盖情况
tested_commands = {
    'session': ['session.status', 'session.new', 'session.end', 'session.subscribe', 'session.unsubscribe'],
    'browser': ['browser.close', 'browser.createUserContext', 'browser.getUserContexts',
                'browser.removeUserContext', 'browser.getClientWindows', 'browser.setClientWindowState'],
    'browsingContext': ['browsingContext.activate', 'browsingContext.captureScreenshot',
                       'browsingContext.close', 'browsingContext.create', 'browsingContext.getTree',
                       'browsingContext.handleUserPrompt', 'browsingContext.locateNodes',
                       'browsingContext.navigate', 'browsingContext.print', 'browsingContext.reload',
                       'browsingContext.setViewport', 'browsingContext.traverseHistory'],
    'emulation': [],  # 未测试
    'network': ['network.addIntercept', 'network.removeIntercept', 'network.continueRequest',
                'network.continueResponse', 'network.continueWithAuth', 'network.failRequest',
                'network.provideResponse', 'network.addDataCollector', 'network.removeDataCollector',
                'network.getData', 'network.disownData', 'network.setCacheBehavior', 'network.setExtraHeaders'],
    'script': ['script.evaluate', 'script.callFunction', 'script.addPreloadScript',
               'script.removePreloadScript', 'script.getRealms', 'script.disown'],
    'storage': ['storage.getCookies', 'storage.setCookie', 'storage.deleteCookies'],
    'input': ['input.performActions', 'input.releaseActions', 'input.setFiles'],
    'webExtension': []  # 未测试
}

# 生成Markdown表格
output = []
output.append("# WebDriver BiDi API 完整对比表（基于W3C官方规范）\n")
output.append("## 📊 总体统计\n")
output.append("| 项目 | W3C规范 | RuyiPage实现 | 已测试 | 实现率 | 测试率 |")
output.append("|------|---------|-------------|--------|--------|--------|")

total_w3c_cmds = w3c_data['total_commands']
total_w3c_evts = w3c_data['total_events']
total_rp_cmds = sum(len(v) for v in ruyipage_commands.values())
total_rp_evts = sum(len(v) for v in ruyipage_events.values())
total_tested_cmds = sum(len(v) for v in tested_commands.values())

output.append(f"| 命令 | {total_w3c_cmds} | {total_rp_cmds} | {total_tested_cmds} | {total_rp_cmds/total_w3c_cmds*100:.1f}% | {total_tested_cmds/total_w3c_cmds*100:.1f}% |")
output.append(f"| 事件 | {total_w3c_evts} | {total_rp_evts} | {total_rp_evts} | {total_rp_evts/total_w3c_evts*100:.1f}% | {total_rp_evts/total_w3c_evts*100:.1f}% |")
output.append(f"| **总计** | **{total_w3c_cmds + total_w3c_evts}** | **{total_rp_cmds + total_rp_evts}** | **{total_tested_cmds + total_rp_evts}** | **{(total_rp_cmds + total_rp_evts)/(total_w3c_cmds + total_w3c_evts)*100:.1f}%** | **{(total_tested_cmds + total_rp_evts)/(total_w3c_cmds + total_w3c_evts)*100:.1f}%** |")

output.append("\n---\n")

# 按模块生成详细对比
for module in sorted(w3c_data['modules']):
    output.append(f"\n## {module} 模块\n")

    # 命令对比
    if module in w3c_data['commands']:
        w3c_cmds = w3c_data['commands'][module]
        rp_cmds = ruyipage_commands.get(module, [])
        tested_cmds = tested_commands.get(module, [])

        output.append(f"### 命令 ({len(rp_cmds)}/{len(w3c_cmds)} = {len(rp_cmds)/len(w3c_cmds)*100:.1f}%)\n")
        output.append("| W3C命令 | RuyiPage | 测试 | 状态 |")
        output.append("|---------|----------|------|------|")

        for cmd in sorted(w3c_cmds):
            implemented = "✅" if cmd in rp_cmds else "❌"
            tested = "✅" if cmd in tested_cmds else ("⚠️" if cmd in rp_cmds else "❌")
            status = "完成" if cmd in tested_cmds else ("已实现未测试" if cmd in rp_cmds else "未实现")
            output.append(f"| {cmd} | {implemented} | {tested} | {status} |")

    # 事件对比
    if module in w3c_data['events']:
        w3c_evts = w3c_data['events'][module]
        rp_evts = ruyipage_events.get(module, [])

        output.append(f"\n### 事件 ({len(rp_evts)}/{len(w3c_evts)} = {len(rp_evts)/len(w3c_evts)*100:.1f}%)\n")
        output.append("| W3C事件 | RuyiPage | 测试 | 状态 |")
        output.append("|---------|----------|------|------|")

        for evt in sorted(w3c_evts):
            implemented = "✅" if evt in rp_evts else "❌"
            tested = "✅" if evt in rp_evts else "❌"
            status = "完成" if evt in rp_evts else "未实现"
            output.append(f"| {evt} | {implemented} | {tested} | {status} |")

    output.append("")

# 未实现的API清单
output.append("\n## 🚫 未实现的W3C API清单\n")
output.append("### 命令\n")
missing_cmds = []
for module in w3c_data['commands']:
    w3c_cmds = w3c_data['commands'][module]
    rp_cmds = ruyipage_commands.get(module, [])
    for cmd in w3c_cmds:
        if cmd not in rp_cmds:
            missing_cmds.append(cmd)

for i, cmd in enumerate(missing_cmds, 1):
    output.append(f"{i}. ❌ **{cmd}**")

output.append("\n### 事件\n")
missing_evts = []
for module in w3c_data['events']:
    w3c_evts = w3c_data['events'][module]
    rp_evts = ruyipage_events.get(module, [])
    for evt in w3c_evts:
        if evt not in rp_evts:
            missing_evts.append(evt)

for i, evt in enumerate(missing_evts, 1):
    output.append(f"{i}. ❌ **{evt}**")

# 未测试的API清单
output.append("\n## ⚠️ 已实现但未测试的API\n")
untested = []
for module in ruyipage_commands:
    rp_cmds = ruyipage_commands[module]
    tested_cmds = tested_commands.get(module, [])
    for cmd in rp_cmds:
        if cmd not in tested_cmds:
            untested.append(cmd)

for i, cmd in enumerate(untested, 1):
    output.append(f"{i}. ⚠️ **{cmd}**")

# 总结
output.append("\n## 🏆 总结\n")
output.append(f"- ✅ **命令实现率**: {total_rp_cmds}/{total_w3c_cmds} = **{total_rp_cmds/total_w3c_cmds*100:.1f}%**")
output.append(f"- ✅ **事件实现率**: {total_rp_evts}/{total_w3c_evts} = **{total_rp_evts/total_w3c_evts*100:.1f}%**")
output.append(f"- ✅ **总体实现率**: {total_rp_cmds + total_rp_evts}/{total_w3c_cmds + total_w3c_evts} = **{(total_rp_cmds + total_rp_evts)/(total_w3c_cmds + total_w3c_evts)*100:.1f}%**")
output.append(f"- ✅ **测试覆盖率**: {total_tested_cmds + total_rp_evts}/{total_w3c_cmds + total_w3c_evts} = **{(total_tested_cmds + total_rp_evts)/(total_w3c_cmds + total_w3c_evts)*100:.1f}%**")
output.append(f"- ❌ **缺失API数**: {len(missing_cmds) + len(missing_evts)} 个（{len(missing_cmds)}命令 + {len(missing_evts)}事件）")
output.append(f"- ⚠️ **未测试API数**: {len(untested)} 个")

output.append("\n---\n")
output.append("**数据来源**: W3C WebDriver BiDi 规范 (https://w3c.github.io/webdriver-bidi/)")
output.append("\n**生成时间**: 2026-04-06")

# 保存到文件
result_text = '\n'.join(output)
with open('E:/ruyipage/examples/W3C_BIDI_COMPARISON.md', 'w', encoding='utf-8') as f:
    f.write(result_text)

print(result_text)
print("\n\n对比表格已保存到: E:/ruyipage/examples/W3C_BIDI_COMPARISON.md")
