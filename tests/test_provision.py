"""Тесты установщика ноды: разбор вывода, шифрование секретов, сам скрипт."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from hub import crypto
from hub.services import provision

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "install-node.sh"

SAMPLE = """\
[node] ставлю Xray
[node] xray: active, hysteria: active

──────────────────────────────────────────────
Готово. Ссылки для клиента:

VLESS_LINK=vless://uuid@203.0.113.10:443?security=reality&pbk=abc&sid=deadbeef&type=tcp#de-1-reality
HY2_LINK=hysteria2://pass@203.0.113.10:8443?sni=www.microsoft.com&insecure=1#de-1-hy2
NODE_IP=203.0.113.10
──────────────────────────────────────────────
"""


def test_parse_result_extracts_links_and_ip():
    result = provision.parse_result(SAMPLE)
    assert result.ok
    assert len(result.links) == 2
    assert result.links[0].startswith("vless://")
    assert result.links[1].startswith("hysteria2://")
    assert result.ip == "203.0.113.10"


def test_parse_result_without_links_is_not_ok():
    result = provision.parse_result("[error] что-то сломалось")
    assert not result.ok
    assert result.links == []


def test_secret_roundtrip():
    token = crypto.encrypt("super-secret-password")
    assert token != "super-secret-password"
    assert crypto.decrypt(token) == "super-secret-password"


def test_decrypt_with_foreign_token_returns_empty():
    assert crypto.decrypt("not-a-fernet-token") == ""
    assert crypto.decrypt("") == ""


def test_target_from_server_detects_password(monkeypatch):
    class S:
        ip = "203.0.113.10"
        ssh_user = "root"
        ssh_port = 2222
        ssh_secret_enc = crypto.encrypt("hunter2")

    target = provision.target_from_server(S())
    assert target.host == "203.0.113.10"
    assert target.port == 2222
    assert target.password == "hunter2"
    assert target.key == ""


def test_installer_exists_and_has_expected_parts():
    assert INSTALLER.exists(), "install-node.sh должен лежать в корне проекта"
    text = INSTALLER.read_text(encoding="utf-8")
    for marker in ("VLESS_LINK=", "HY2_LINK=", "xtls-rprx-vision", "x25519", "ufw", "bbr"):
        assert marker in text, f"в установщике нет {marker}"


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash недоступен на этой машине")
def test_installer_passes_bash_syntax_check():
    proc = subprocess.run(["bash", "-n", str(INSTALLER)], capture_output=True, text=True)
    stderr = proc.stderr or ""
    # На Windows MSYS иногда не может форкнуться из-под pytest — это не ошибка скрипта.
    if "fatal error - NtCreateDirectoryObject" in stderr or "msys-2.0" in stderr:
        pytest.skip("bash не запускается в этом окружении (MSYS fork error)")
    assert proc.returncode == 0, stderr
