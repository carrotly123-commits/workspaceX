# -*- coding: utf-8 -*-
"""EmulationManager - 设备模拟管理器"""

from .._bidi import emulation as bidi_emulation
from .._bidi import browsing_context as bidi_context
import logging

logger = logging.getLogger("ruyipage")


class EmulationManager(object):
    """设备模拟管理器

    用法::

        page.emulation.set_geolocation(39.9, 116.4)
        page.emulation.set_timezone('Asia/Shanghai')
        page.emulation.set_locale(['zh-CN', 'zh'])
        page.emulation.set_screen_orientation('landscape-primary')
    """

    def __init__(self, owner):
        self._owner = owner

    def _ctx(self):
        return [self._owner._context_id]

    def _user_context(self):
        try:
            result = bidi_context.get_tree(
                self._owner._driver._browser_driver,
                max_depth=0,
                root=self._owner._context_id,
            )
            contexts = result.get("contexts", [])
            if contexts:
                return contexts[0].get("userContext")
        except Exception as e:
            logger.debug("get current user context failed: %s", e)
        return None

    def _supported(self, result):
        """判断底层命令是否被当前浏览器实现支持。

        Args:
            result: 底层 BiDi 命令返回值。
                常见值：命令成功时为空字典 ``{}``，不支持时为 ``None``。

        Returns:
            bool: ``True`` 表示当前浏览器实现了该命令，``False`` 表示命令未实现。

        适用场景：
            - 示例中区分“成功”和“不支持”
            - 高层 API 向调用方返回统一的布尔支持结果
        """
        return result is not None

    def set_geolocation(self, latitude, longitude, accuracy=100):
        """设置地理位置 (FF139+)。

        Args:
            latitude: 纬度
            longitude: 经度
            accuracy: 精度（米），常见值 50~100

        Returns:
            owner
        """
        bidi_emulation.set_geolocation_override(
            self._owner._driver._browser_driver,
            latitude=latitude,
            longitude=longitude,
            accuracy=accuracy,
            contexts=self._ctx(),
        )
        return self._owner

    def clear_geolocation(self):
        """清除地理位置覆盖"""
        bidi_emulation.set_geolocation_override(
            self._owner._driver._browser_driver, contexts=self._ctx()
        )
        return self._owner

    def set_timezone(self, timezone_id):
        """设置时区 (FF144+)。

        Args:
            timezone_id: 时区标识，如 'Asia/Shanghai' / 'America/New_York'
        """
        bidi_emulation.set_timezone_override(
            self._owner._driver._browser_driver,
            timezone_id=timezone_id,
            contexts=self._ctx(),
        )
        return self._owner

    def set_locale(self, locales):
        """设置语言 (FF142+)。

        Args:
            locales: 语言字符串或列表，如 'ja-JP' 或 ['zh-CN', 'zh']
        """
        bidi_emulation.set_locale_override(
            self._owner._driver._browser_driver, locales=locales, contexts=self._ctx()
        )
        return self._owner

    def set_screen_orientation(self, orientation_type, angle=0):
        """设置屏幕方向 (FF144+)

        Args:
            orientation_type: 'portrait-primary'/'landscape-primary' 等
            angle: 0/90/180/270
        """
        bidi_emulation.set_screen_orientation_override(
            self._owner._driver._browser_driver,
            orientation_type=orientation_type,
            angle=angle,
            contexts=self._ctx(),
        )
        return self._owner

    def set_screen_size(self, width, height, device_pixel_ratio=None):
        """设置屏幕尺寸 (FF147+)。

        Args:
            width: 屏幕宽度（CSS 像素）
            height: 屏幕高度（CSS 像素）
            device_pixel_ratio: 设备像素比，例如 2.0 / 3.0
        """
        user_context = self._user_context()
        scope = (
            {"user_contexts": [user_context]}
            if user_context
            else {"contexts": self._ctx()}
        )
        result = bidi_emulation.set_screen_settings_override(
            self._owner._driver._browser_driver,
            width=width,
            height=height,
            device_pixel_ratio=device_pixel_ratio,
            **scope,
        )
        if result is None:
            bidi_emulation.inject_screen_settings_override(
                self._owner._driver._browser_driver,
                self._owner._context_id,
                width,
                height,
                device_pixel_ratio=device_pixel_ratio,
            )
        return self._owner

    def set_user_agent(self, user_agent, platform=None):
        """设置 UA (FF145+)，旧版自动回退到 preload script。

        Args:
            user_agent: UA 字符串
            platform: 可选平台名，例如 'iPhone'
        """
        result = bidi_emulation.set_user_agent_override(
            self._owner._driver._browser_driver,
            user_agent=user_agent,
            platform=platform,
            contexts=self._ctx(),
        )
        if result is None:
            # 回退到 preload script 方式
            self._owner.set_useragent(user_agent)
        return self._owner

    def set_network_offline(self, enabled=True):
        """模拟离线/在线网络状态。

        Args:
            enabled: True=离线, False=在线

        Returns:
            bool: 当前浏览器是否支持该命令
        """
        result = bidi_emulation.set_network_conditions(
            self._owner._driver._browser_driver,
            offline=enabled,
            contexts=self._ctx(),
        )
        return self._supported(result)

    def set_touch_enabled(self, enabled=True, max_touch_points=1, scope="context"):
        """启用/禁用触摸模拟。

        Args:
            enabled: True=启用，False=禁用
            max_touch_points: 启用时的最大触点数，通常为 1 或 5
            scope: 'context' / 'global' / 'user_context'

        Returns:
            bool: 当前浏览器是否支持该命令
        """
        value = max_touch_points if enabled else None
        if scope == "global":
            result = bidi_emulation.set_touch_override(
                self._owner._driver._browser_driver,
                max_touch_points=value,
            )
        elif scope == "user_context":
            user_context = getattr(self._owner.browser.options, "user_context", None)
            result = bidi_emulation.set_touch_override(
                self._owner._driver._browser_driver,
                max_touch_points=value,
                user_contexts=user_context if user_context else None,
            )
        else:
            result = bidi_emulation.set_touch_override(
                self._owner._driver._browser_driver,
                max_touch_points=value,
                contexts=self._ctx(),
            )
        return self._supported(result)

    def set_javascript_enabled(self, enabled=True):
        """启用/禁用 JavaScript。

        Args:
            enabled: 是否启用 JavaScript。
                常见值：``True`` 启用、``False`` 禁用。

        Returns:
            bool: ``True`` 表示当前浏览器支持该标准命令，``False`` 表示未实现。

        适用场景：
            - 判断当前 Firefox 是否支持 ``emulation.setScriptingEnabled``
            - 在示例里明确标记“成功”或“不支持”
        """
        result = bidi_emulation.set_scripting_enabled(
            self._owner._driver._browser_driver,
            enabled=enabled,
            contexts=self._ctx(),
        )
        return self._supported(result)

    def set_scrollbar_type(self, scrollbar_type="overlay"):
        """设置滚动条类型。

        Args:
            scrollbar_type: 目标滚动条类型。
                常见值：``'none'``、``'standard'``、``'overlay'``。

        Returns:
            bool: ``True`` 表示当前浏览器支持该标准命令，``False`` 表示未实现。

        适用场景：
            - 测试不同滚动条呈现方式
            - 判断当前 Firefox 是否支持 ``emulation.setScrollbarTypeOverride``
        """
        result = bidi_emulation.set_scrollbar_type_override(
            self._owner._driver._browser_driver,
            scrollbar_type=scrollbar_type,
            contexts=self._ctx(),
        )
        return self._supported(result)

    def set_forced_colors_mode(self, mode="dark"):
        """设置强制颜色模式。

        Args:
            mode: 目标模式。
                常见值：``'none'``、``'active'``、``'light'``、``'dark'``。

        Returns:
            bool: ``True`` 表示当前浏览器支持该标准命令，``False`` 表示未实现。

        适用场景：
            - 测试强制颜色主题覆盖
            - 判断当前 Firefox 是否支持 ``emulation.setForcedColorsModeThemeOverride``
        """
        result = bidi_emulation.set_forced_colors_mode_theme_override(
            self._owner._driver._browser_driver,
            mode=mode,
            contexts=self._ctx(),
        )
        return self._supported(result)

    def set_bypass_csp(self, enabled=True):
        """设置是否绕过 CSP。返回当前浏览器是否支持。"""
        result = bidi_context.set_bypass_csp(
            self._owner._driver._browser_driver,
            context=self._owner._context_id,
            enabled=enabled,
        )
        return self._supported(result)

    def apply_mobile_preset(
        self,
        user_agent,
        *,
        width=390,
        height=844,
        device_pixel_ratio=3.0,
        orientation_type="portrait-primary",
        angle=0,
        locale=None,
        timezone_id=None,
        touch=True,
    ):
        """一键应用常见移动端模拟参数（新手友好）。

        Returns:
            dict: 每项能力是否支持
        """
        support = {
            "user_agent": True,
            "screen": True,
            "orientation": True,
            "touch": self.set_touch_enabled(touch) if touch is not None else None,
            "locale": None,
            "timezone": None,
        }

        try:
            self.set_user_agent(user_agent)
        except Exception:
            support["user_agent"] = False

        try:
            self.set_screen_size(width, height, device_pixel_ratio=device_pixel_ratio)
        except Exception:
            support["screen"] = False

        try:
            # 移动端访问不仅要改 screen，还要改当前浏览上下文的 viewport。
            self._owner.set_viewport(
                width, height, device_pixel_ratio=device_pixel_ratio
            )
        except Exception:
            support["screen"] = False

        try:
            self.set_screen_orientation(orientation_type, angle=angle)
        except Exception:
            support["orientation"] = False

        if locale:
            try:
                self.set_locale(locale)
                support["locale"] = True
            except Exception:
                support["locale"] = False

        if timezone_id:
            try:
                self.set_timezone(timezone_id)
                support["timezone"] = True
            except Exception:
                support["timezone"] = False

        return support
