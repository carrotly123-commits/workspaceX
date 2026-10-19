# -*- coding: utf-8 -*-
"""StaticElement - 从 HTML 字符串解析的静态元素

不需要浏览器连接，纯本地 HTML 解析。
"""

import re


class StaticElement(object):
    """静态 HTML 元素（无浏览器连接）"""

    _type = 'StaticElement'

    def __init__(self, tag, attrs, text='', inner_html='', outer_html=''):
        self._tag = tag
        self._attrs = attrs
        self._text = text
        self._inner_html = inner_html
        self._outer_html = outer_html

    @property
    def tag(self):
        return self._tag

    @property
    def text(self):
        return self._text

    @property
    def html(self):
        return self._outer_html

    @property
    def outer_html(self):
        return self._outer_html

    @property
    def inner_html(self):
        return self._inner_html

    @property
    def attrs(self):
        return self._attrs.copy()

    @property
    def link(self):
        return self._attrs.get('href', '')

    @property
    def src(self):
        return self._attrs.get('src', '')

    @property
    def value(self):
        return self._attrs.get('value', '')

    def attr(self, name):
        return self._attrs.get(name)

    def __repr__(self):
        return '<StaticElement {} "{}">'.format(
            self._tag, self._text[:30] + '...' if len(self._text) > 30 else self._text)

    def __str__(self):
        return self._text

    def __bool__(self):
        return True


def make_static_ele(html, locator=None):
    """从 HTML 创建静态元素

    Args:
        html: HTML 字符串
        locator: 可选定位器

    Returns:
        StaticElement 或 NoneElement
    """
    try:
        from lxml import etree
        return _make_with_lxml(html, locator)
    except ImportError:
        return _make_with_re(html, locator)


def make_static_eles(html, locator):
    """从 HTML 创建多个静态元素"""
    try:
        from lxml import etree
        return _make_eles_with_lxml(html, locator)
    except ImportError:
        return _make_eles_with_re(html, locator)


def _make_with_lxml(html, locator=None):
    """使用 lxml 解析"""
    from lxml import etree
    from .._functions.locator import parse_locator

    try:
        tree = etree.HTML(html)
    except Exception:
        return _none()

    if locator is None:
        root = tree
        return StaticElement(
            tag=root.tag,
            attrs=dict(root.attrib),
            text=_lxml_text(root),
            inner_html=_lxml_inner_html(root),
            outer_html=etree.tostring(root, encoding='unicode', method='html')
        )

    bidi_loc = parse_locator(locator)
    loc_type = bidi_loc.get('type', '')
    loc_value = bidi_loc.get('value', '')

    elements = []
    if loc_type == 'css':
        try:
            from lxml.cssselect import CSSSelector
            sel = CSSSelector(loc_value)
            elements = sel(tree)
        except Exception:
            return _none()
    elif loc_type == 'xpath':
        try:
            elements = tree.xpath(loc_value)
        except Exception:
            return _none()
    elif loc_type == 'innerText':
        try:
            elements = tree.xpath('//*[contains(text(), "{}")]'.format(
                loc_value.replace('"', '\\"')))
        except Exception:
            return _none()

    if elements:
        e = elements[0]
        return StaticElement(
            tag=e.tag if hasattr(e, 'tag') else '',
            attrs=dict(e.attrib) if hasattr(e, 'attrib') else {},
            text=_lxml_text(e),
            inner_html=_lxml_inner_html(e),
            outer_html=etree.tostring(e, encoding='unicode', method='html')
                       if hasattr(e, 'tag') else str(e)
        )

    return _none()


def _make_eles_with_lxml(html, locator):
    """使用 lxml 查找多个元素"""
    from lxml import etree
    from .._functions.locator import parse_locator

    try:
        tree = etree.HTML(html)
    except Exception:
        return []

    bidi_loc = parse_locator(locator)
    loc_type = bidi_loc.get('type', '')
    loc_value = bidi_loc.get('value', '')

    elements = []
    if loc_type == 'css':
        try:
            from lxml.cssselect import CSSSelector
            sel = CSSSelector(loc_value)
            elements = sel(tree)
        except Exception:
            return []
    elif loc_type == 'xpath':
        try:
            elements = tree.xpath(loc_value)
        except Exception:
            return []
    elif loc_type == 'innerText':
        try:
            elements = tree.xpath('//*[contains(text(), "{}")]'.format(
                loc_value.replace('"', '\\"')))
        except Exception:
            return []

    result = []
    for e in elements:
        if hasattr(e, 'tag'):
            result.append(StaticElement(
                tag=e.tag,
                attrs=dict(e.attrib),
                text=_lxml_text(e),
                inner_html=_lxml_inner_html(e),
                outer_html=etree.tostring(e, encoding='unicode', method='html')
            ))

    return result


def _lxml_text(element):
    """获取 lxml 元素的完整文本"""
    return ''.join(element.itertext()) if hasattr(element, 'itertext') else ''


def _lxml_inner_html(element):
    """获取 lxml 元素的内部 HTML"""
    from lxml import etree
    parts = []
    if element.text:
        parts.append(element.text)
    for child in element:
        parts.append(etree.tostring(child, encoding='unicode', method='html'))
    return ''.join(parts)


def _make_with_re(html, locator=None):
    """正则回退解析（不依赖 lxml）"""
    if locator is None:
        # 返回包装整个 HTML 的元素
        return StaticElement(
            tag='html',
            attrs={},
            text=_strip_tags(html),
            inner_html=html,
            outer_html=html
        )

    from .._functions.locator import parse_locator
    bidi_loc = parse_locator(locator)
    loc_type = bidi_loc.get('type', '')
    loc_value = bidi_loc.get('value', '')

    if loc_type in ('css', 'innerText'):
        # 简单的标签匹配
        tag_match = re.match(r'^(\w+)', loc_value) if loc_type == 'css' else None
        if tag_match:
            tag = tag_match.group(1)
            pattern = r'<{tag}[^>]*>(.*?)</{tag}>'.format(tag=tag)
            m = re.search(pattern, html, re.DOTALL | re.IGNORECASE)
            if m:
                outer = m.group(0)
                inner = m.group(1)
                return StaticElement(
                    tag=tag, attrs={},
                    text=_strip_tags(inner),
                    inner_html=inner, outer_html=outer
                )

    return _none()


def _make_eles_with_re(html, locator):
    """正则回退查找多个元素"""
    return []  # 简化实现


def _strip_tags(html):
    """去除 HTML 标签"""
    return re.sub(r'<[^>]+>', '', html).strip()


def _none():
    """返回 NoneElement"""
    from .none_element import NoneElement
    return NoneElement()
