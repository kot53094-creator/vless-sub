"""Установка ноды на чистый VPS по SSH.

Скрипт `install-node.sh` копируется на сервер и запускается под sudo.
Из его вывода вытаскиваются ссылки (`VLESS_LINK=`, `HY2_LINK=`), которые
потом попадают в источник типа `own_vps`.

SSH работает в отдельном потоке: paramiko блокирующий, а FastAPI — нет.
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

import paramiko

from ..crypto import decrypt

ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / "install-node.sh"

LINK_RE = re.compile(r"^(?:VLESS_LINK|HY2_LINK)=(\S+)$", re.MULTILINE)
IP_RE = re.compile(r"^NODE_IP=(\S+)$", re.MULTILINE)


class ProvisionError(RuntimeError):
    pass


@dataclass
class Target:
    host: str
    user: str = "root"
    port: int = 22
    password: str = ""
    key: str = ""


@dataclass
class ProvisionResult:
    links: list[str] = field(default_factory=list)
    ip: str = ""
    log: str = ""

    @property
    def ok(self) -> bool:
        return bool(self.links)


def parse_result(output: str) -> ProvisionResult:
    """Вытащить ссылки и IP из вывода установщика."""
    links = [match.group(1) for match in LINK_RE.finditer(output)]
    ip = IP_RE.search(output)
    return ProvisionResult(links=links, ip=ip.group(1) if ip else "", log=output[-20000:])


def _load_key(text: str) -> paramiko.PKey:
    """Ключ может быть ed25519, ECDSA или RSA — пробуем по порядку."""
    errors = []
    for cls in (paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.RSAKey):
        try:
            return cls.from_private_key_string(text)
        except Exception as exc:  # noqa: BLE001 - у каждого типа своё исключение
            errors.append(f"{cls.__name__}: {exc}")
    raise ProvisionError("SSH: не удалось прочитать приватный ключ (" + "; ".join(errors)[:200] + ")")


def _connect(target: Target, timeout: float) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kwargs: dict = {
        "hostname": target.host,
        "port": target.port or 22,
        "username": target.user or "root",
        "timeout": timeout,
        "banner_timeout": timeout,
        "auth_timeout": timeout,
        "allow_agent": False,
        "look_for_keys": False,
    }
    if target.key:
        kwargs["pkey"] = _load_key(target.key)
    else:
        kwargs["password"] = target.password

    try:
        client.connect(**kwargs)
    except paramiko.AuthenticationException as exc:
        raise ProvisionError("SSH: неверный логин, пароль или ключ") from exc
    except paramiko.SSHException as exc:
        raise ProvisionError(f"SSH: {exc}") from exc
    except OSError as exc:
        raise ProvisionError(f"SSH: нет связи с {target.host}:{target.port} ({exc})") from exc
    return client


def _run_blocking(target: Target, node_name: str, node_port: int, hy2_port: int,
                  timeout: float) -> ProvisionResult:
    if not INSTALLER.exists():
        raise ProvisionError("install-node.sh не найден рядом с приложением")

    client = _connect(target, timeout=20)
    try:
        script = INSTALLER.read_text(encoding="utf-8")
        sftp = client.open_sftp()
        with sftp.file("/tmp/install-node.sh", "w") as remote:
            remote.write(script)
        sftp.chmod("/tmp/install-node.sh", 0o755)
        sftp.close()

        command = (
            f"sudo NODE_NAME={node_name} NODE_PORT={node_port} HY2_PORT={hy2_port} "
            "bash /tmp/install-node.sh 2>&1"
        )
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout, get_pty=True)
        stdin.close()

        chunks: list[str] = []
        deadline = time.monotonic() + timeout
        for line in iter(stdout.readline, ""):
            chunks.append(line)
            if time.monotonic() > deadline:
                raise ProvisionError("установка не уложилась в отведённое время")
        output = "".join(chunks)
        result = parse_result(output)
        if not result.ok:
            raise ProvisionError("установщик не вернул ссылки — смотрите лог")
        return result
    finally:
        client.close()


async def provision(target: Target, node_name: str, node_port: int = 443,
                    hy2_port: int = 8443, timeout: float = 900) -> ProvisionResult:
    return await asyncio.to_thread(_run_blocking, target, node_name, node_port, hy2_port, timeout)


def target_from_server(server) -> Target:
    """Server из БД → Target (секрет расшифровывается здесь же)."""
    secret = decrypt(server.ssh_secret_enc)
    if secret.startswith("ssh-") or "PRIVATE KEY" in secret:
        return Target(host=server.ip, user=server.ssh_user, port=server.ssh_port, key=secret)
    return Target(host=server.ip, user=server.ssh_user, port=server.ssh_port, password=secret)
