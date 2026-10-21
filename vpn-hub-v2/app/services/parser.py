"""Разбор ссылок и подписок. Без сети — только текст."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from dataclasses import dataclass, field
from urllib.parse import parse_qs, unquote, urlparse

SUPPORTED = ("vless", "vmess", "trojan", "hysteria2", "ss")
ALIASES = {"hy2": "hysteria2", "hysteria": "hysteria2", "shadowsocks": "ss"}
MAX_KEYS = 300


@dataclass(slots=True)
class ParsedKey:
    proto: str
    uri: str
    host: str
    port: int
    remark: str = ""
    security: str = ""
    params: dict[str, str] = field(default_factory=dict)

    @property
    def fingerprint(self) -> str:
        secret = self.params.get("id") or self.params.get("password") or ""
        raw = f"{self.proto}|{self.host.lower()}|{self.port}|{secret}"
        return hashlib.sha1(raw.encode()).hexdigest()

    @property
    def is_tls(self) -> bool:
        return self.security in ("tls", "reality", "xtls")

    @property
    def is_reality(self) -> bool:
        return self.security == "reality"

    @property
    def is_udp(self) -> bool:
        return self.proto == "hysteria2"


def _b64(text: str) -> str | None:
    value = text.strip().replace("-", "+").replace("_", "/").replace("\n", "").replace("\r", "")
    if not value:
        return None
    value += "=" * ((-len(value)) % 4)
    try:
        raw = base64.b64decode(value, validate=False)
        decoded = raw.decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    return decoded if decoded.strip() else None


def is_single_key(text: str) -> bool:
    return text.strip().lower().startswith(
        tuple(f"{scheme}://" for scheme in (*SUPPORTED, "hy2"))
    ) and "\n" not in text.strip()


def is_subscription_url(text: str) -> bool:
    return text.strip().lower().startswith(("http://", "https://"))


def decode_body(text: str) -> str:
    if "://" not in text and len(text.strip()) > 16:
        decoded = _b64(text)
        if decoded and "://" in decoded:
            return decoded
    return text


def _split_host_port(netloc: str) -> tuple[str, int]:
    if netloc.startswith("["):
        host, _, rest = netloc[1:].partition("]")
        return host, int(rest.lstrip(":") or 443)
    if "@" in netloc:
        netloc = netloc.rsplit("@", 1)[1]
    if ":" in netloc:
        host, _, port = netloc.rpartition(":")
        return host, int(port) if port.isdigit() else 443
    return netloc, 443


def _parse_vmess(uri: str) -> ParsedKey | None:
    decoded = _b64(uri[len("vmess://") :])
    if not decoded:
        return None
    try:
        data = json.loads(decoded)
    except json.JSONDecodeError:
        return None
    host = str(data.get("add") or "")
    if not host:
        return None
    return ParsedKey(
        proto="vmess",
        uri=uri,
        host=host,
        port=int(data.get("port") or 443),
        remark=str(data.get("ps") or ""),
        security="tls" if str(data.get("tls") or "") in ("tls", "reality") else "",
        params={
            "id": str(data.get("id") or ""),
            "type": str(data.get("net") or "tcp"),
            "sni": str(data.get("sni") or ""),
        },
    )


def _parse_ss(uri: str) -> ParsedKey | None:
    body = uri[len("ss://") :]
    remark = ""
    if "#" in body:
        body, _, frag = body.partition("#")
        remark = unquote(frag)
    if "@" in body:
        userinfo, _, netloc = body.rpartition("@")
        decoded = _b64(unquote(userinfo)) or unquote(userinfo)
        host, port = _split_host_port(netloc.split("?")[0])
    else:
        decoded = _b64(unquote(body.split("?")[0]))
        if not decoded or "@" not in decoded:
            return None
        userinfo, _, netloc = decoded.rpartition("@")
        host, port = _split_host_port(netloc)
        decoded = userinfo
    password = decoded.split(":", 1)[1] if ":" in decoded else ""
    if not host:
        return None
    return ParsedKey(
        proto="ss",
        uri=uri,
        host=host,
        port=port,
        remark=remark,
        params={"password": password},
    )


def parse_uri(uri: str) -> ParsedKey | None:
    uri = uri.strip().split()[0] if uri.strip() else ""
    if "://" not in uri:
        return None
    scheme = ALIASES.get(uri.split("://", 1)[0].lower(), uri.split("://", 1)[0].lower())
    if scheme not in SUPPORTED:
        return None
    if scheme == "vmess":
        return _parse_vmess(uri)
    if scheme == "ss":
        return _parse_ss(uri)

    try:
        parsed = urlparse(uri)
    except ValueError:
        return None
    if not parsed.hostname:
        return None
    query = {k: v[0] for k, v in parse_qs(parsed.query, keep_blank_values=True).items()}
    security = (query.get("security") or "").lower()
    if scheme in ("trojan", "hysteria2") and not security:
        security = "tls"
    params = dict(query)
    params["password"] = unquote(parsed.password or parsed.username or "")
    params["id"] = unquote(parsed.username or "")
    return ParsedKey(
        proto=scheme,
        uri=uri,
        host=parsed.hostname,
        port=int(parsed.port or 443),
        remark=unquote(parsed.fragment or ""),
        security=security,
        params=params,
    )


def parse_subscription(text: str, limit: int = MAX_KEYS) -> list[ParsedKey]:
    """Текст подписки → уникальные ключи. Мусор пропускается."""
    body = decode_body(text)
    keys: list[ParsedKey] = []
    seen: set[str] = set()
    for raw in body.replace("\r", "\n").split("\n"):
        line = raw.strip()
        if not line or line.startswith("//"):
            continue
        parsed = parse_uri(line)
        if not parsed:
            continue
        if parsed.fingerprint in seen:
            continue
        seen.add(parsed.fingerprint)
        keys.append(parsed)
        if len(keys) >= limit:
            break
    return keys


def parse_userinfo(header: str | None) -> dict[str, int | None]:
    out: dict[str, int | None] = {"upload": None, "download": None, "total": None, "expire": None}
    if not header:
        return out
    for part in header.split(";"):
        name, _, value = part.partition("=")
        name = name.strip().lower()
        if name not in out:
            continue
        try:
            out[name] = int(float(value.strip()))
        except ValueError:
            continue
    return out


def to_base64(lines: list[str]) -> str:
    return base64.b64encode("\n".join(lines).strip().encode()).decode()


def with_label(uri: str, label: str) -> str:
    return f"{uri.split('#', 1)[0]}#{label.replace('#', ' ')}"
