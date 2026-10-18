# -*- coding: utf-8 -*-

import ast
import importlib.util
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
EXAMPLE_PATH = ROOT_DIR / "examples" / "http_socks5_examples" / "01_http_password_proxy.py"


def load_example():
    spec = importlib.util.spec_from_file_location("http_password_proxy_example", EXAMPLE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_parse_http_proxy_accepts_full_http_url():
    module = load_example()

    proxy = module.parse_http_proxy("http://user-value:pass-value@proxy.example.com:8080")

    assert proxy == {
        "host": "proxy.example.com",
        "port": 8080,
        "username": "user-value",
        "password": "pass-value",
    }


def test_httpauth_fpfile_contains_proxy_and_credentials(tmp_path):
    module = load_example()
    fpfile = tmp_path / "httpauth.txt"
    proxy = {
        "host": "proxy.example.com",
        "port": 8080,
        "username": "user-value",
        "password": "pass-value",
    }

    module.write_httpauth_fpfile(
        str(fpfile),
        proxy["host"],
        proxy["port"],
        proxy["username"],
        proxy["password"],
    )

    content = fpfile.read_text(encoding="utf-8")
    assert "httpauth.host:proxy.example.com" in content
    assert "httpauth.port:8080" in content
    assert "httpauth.username:user-value" in content
    assert "httpauth.password:pass-value" in content


def test_example_uses_direct_fpfile_without_set_proxy():
    source = EXAMPLE_PATH.read_text(encoding="utf-8")
    tree = ast.parse(source)

    set_proxy_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "set_proxy"
    ]
    assert set_proxy_calls == []


def test_parse_args_defaults_to_headless(monkeypatch):
    module = load_example()
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "01_http_password_proxy.py",
            "--proxy",
            "user-value:pass-value@proxy.example.com:8080",
        ],
    )

    args = module.parse_args()

    assert args.headless is True
