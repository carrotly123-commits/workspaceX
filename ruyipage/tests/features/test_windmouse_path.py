# -*- coding: utf-8 -*-

import math
import random

import pytest

from ruyipage._units.actions import Actions


class _DummyOwner(object):
    pass


@pytest.mark.feature
def test_windmouse_path_converges_without_endpoint_oscillation():
    actions = Actions(_DummyOwner())

    random.seed(70)
    path = actions._build_windmouse_path((100, 100), (500, 300))

    assert len(path) < 120
    assert path[-1] == (500.0, 300.0)
    assert all(
        math.hypot(x - 500, y - 300) > 1.0
        for x, y in path[-12:-1]
    )
