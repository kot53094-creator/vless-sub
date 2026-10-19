#!/usr/bin/env python3
"""
Merge, validate, deduplicate and probe public VLESS subscriptions
into one v2rayNG-compatible subscription file.

Design rules implemented here:
  * only plain text / base64 / JSON data is fetched -- nothing is executed;
  * a source that fails does not break the build;
  * a config is never considered "working" just because it was downloaded;
    reachability is measured separately and printed as its own tier;
  * an empty or suspiciously small result never overwrites a good one;
  * secrets (private subscription URL) are never printed.

Output (default ./docs):
  sub.txt           base64 subscription, only endpoints that answered a probe
  sub-plain.txt     same list, one URI per line
  status.json       build metadata / per-source health
  index.html        small landing page
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import hashlib
import ipaddress
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from urllib.parse import parse_qs, quote, unquote, urlsplit

import dashboard
import xray_check

UA = "v2rayNG/1.9.16"
MAX_SOURCE_BYTES = 16 * 1024 * 1024
# One colour per key so blocks stay readable in the client list.
KEY_COLORS = ("🟠", "🔵", "🟣", "🟢", "🟡", "🔴", "🟤", "⚫")
FREE_COLOR = "⚪"
UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
NETWORKS = {
    "tcp", "ws", "grpc", "h2", "http", "httpupgrade",
    "xhttp", "splithttp", "quic", "kcp", "mkcp",
}
SECURITIES = {"none", "tls", "reality", "xtls"}
FLOWS = {"", "xtls-rprx-vision", "xtls-rprx-vision-udp443", "xtls-rprx-direct"}
# VLESS может требовать собственное шифрование канала
# (mlkem768x25519plus.native.0rtt.<key>) — без него сервер не пустит клиента.
ENCRYPTION_RE = re.compile(r"^[A-Za-z0-9._+/=-]{1,2048}$")
PRIVATE_HOST_SUFFIXES = (".local", ".localhost", ".internal", ".lan", ".home")


class Bad(Exception):
    """Config rejected by the validator."""


class FetchError(Exception):
    """Source could not be downloaded."""


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def b64decode_loose(text: str) -> bytes:
    compact = re.sub(r"\s+", "", text)
    compact += "=" * (-len(compact) % 4)
    return base64.b64decode(compact, validate=False)


def b64encode_std(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def sanitize_line(line: str) -> str:
    line = line.lstrip("\ufeff").strip()
    if " | " in line:            # some feeds append "| CC | 123ms | 2d"
        line = line.split(" | ", 1)[0].strip()
    return line.strip().strip('"').strip("'")


def is_private_host(host: str) -> bool:
    h = host.strip("[]").lower()
    if not h or h in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}:
        return True
    if h.endswith(PRIVATE_HOST_SUFFIXES):
        return True
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved


def mask_url(url: str, private: bool) -> str:
    return "<private source>" if private else url


# --------------------------------------------------------------------------- #
# fetching
# --------------------------------------------------------------------------- #

def decode_title(value: str) -> str:
    """Panels send `profile-title` either plain or as `base64:<data>`."""
    value = value or ""
    if value.lower().startswith("base64:"):
        try:
            return base64.b64decode(value[7:] + "===").decode("utf-8", "replace").strip()
        except Exception:  # noqa: BLE001
            return ""
    return value.strip()


def parse_userinfo(value: str) -> dict:
    """`upload=0; download=1; total=2; expire=1792455564` -> dict of ints."""
    quota: dict = {}
    for part in (value or "").split(";"):
        key, _, raw = part.partition("=")
        key = key.strip().lower()
        raw = raw.strip()
        if key and raw.lstrip("-").isdigit():
            quota[key] = int(raw)
    return quota


def fetch_meta(url: str, timeout: float = 30.0, retries: int = 2,
               extra: dict | None = None) -> tuple[str, dict]:
    """Fetch text plus the headers the panel uses to report quota and expiry.

    `extra` carries per-key request headers: some panels only serve real
    configs to their own client and answer everyone else with a placeholder.
    """
    if url.startswith("file:"):
        return fetch_text(url), {}
    last = None
    headers = {"User-Agent": UA, "Accept": "*/*", "Accept-Encoding": "identity"}
    if extra:
        headers.update({k: v for k, v in extra.items() if v})
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read(MAX_SOURCE_BYTES + 1)
                headers = {k.lower(): v for k, v in resp.headers.items()}
            return raw.decode("utf-8", "replace"), headers
        except Exception as exc:                      # noqa: BLE001
            last = exc
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    raise FetchError(f"{type(last).__name__}: {last}")


def fetch_text(url: str, timeout: float = 30.0, retries: int = 2,
               extra: dict | None = None) -> str:
    if url.startswith("file:"):
        path = url[5:].lstrip("/\\")
        with open(path, "r", encoding="utf-8-sig") as fh:
            return fh.read(MAX_SOURCE_BYTES)
    last = None
    headers = {"User-Agent": UA, "Accept": "*/*", "Accept-Encoding": "identity"}
    if extra:
        headers.update({k: v for k, v in extra.items() if v})
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read(MAX_SOURCE_BYTES + 1)
            if len(raw) > MAX_SOURCE_BYTES:
                raise ValueError("source larger than 16 MB, skipped")
            return raw.decode("utf-8", "replace")
        except Exception as exc:                      # noqa: BLE001
            last = exc
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    raise FetchError(f"{type(last).__name__}: {last}")


# --------------------------------------------------------------------------- #
# payload decoding: plain lines | base64 blob | xray JSON subscription
# --------------------------------------------------------------------------- #

def xray_json_to_uris(text: str) -> list[str]:
    """Convert a JSON subscription (array of full Xray client configs) to URIs.

    Only the fields needed to rebuild a client URI are read. Nothing is executed.
    """
    data = json.loads(text)
    configs = data if isinstance(data, list) else [data]
    out: list[str] = []
    for cfg in configs:
        if not isinstance(cfg, dict):
            continue
        remark = str(cfg.get("remarks") or cfg.get("remark") or "").strip()
        usable = [o for o in (cfg.get("outbounds") or [])
                  if isinstance(o, dict) and str(o.get("protocol", "")).lower() in {"vless", "trojan"}]
        for pos, ob in enumerate(usable, 1):
            proto = str(ob.get("protocol", "")).lower()
            ss = ob.get("streamSettings") or {}
            net = str(ss.get("network") or "tcp").lower()
            if net == "raw":
                net = "tcp"
            sec = str(ss.get("security") or "none").lower()
            params: dict[str, str] = {"type": net, "security": sec, "encryption": "none"}
            sni = ""
            if sec == "tls":
                tls = ss.get("tlsSettings") or {}
                sni = str(tls.get("serverName") or "")
                fp = str((tls.get("settings") or {}).get("fingerprint") or "")
                if fp:
                    params["fp"] = fp
                alpn = tls.get("alpn") or []
                if alpn:
                    params["alpn"] = ",".join(str(a) for a in alpn)
            elif sec == "reality":
                rs = ss.get("realitySettings") or {}
                sni = str(rs.get("serverName") or "")
                for src, dst in (("publicKey", "pbk"), ("shortId", "sid"),
                                 ("fingerprint", "fp"), ("spiderX", "spx")):
                    val = rs.get(src)
                    if val:
                        params[dst] = str(val)
            if net == "ws":
                ws = ss.get("wsSettings") or {}
                params["path"] = str(ws.get("path") or "/")
                hdr = (ws.get("headers") or {}).get("Host")
                if hdr:
                    params["host"] = str(hdr)
            elif net == "grpc":
                grpc = ss.get("grpcSettings") or {}
                params["serviceName"] = str(grpc.get("serviceName") or "")
            elif net in {"xhttp", "splithttp"}:
                xh = ss.get("xhttpSettings") or ss.get("splithttpSettings") or {}
                params["path"] = str(xh.get("path") or "/")
                hdr = (xh.get("headers") or {}).get("Host")
                if hdr:
                    params["host"] = str(hdr)
                mode = str(xh.get("mode") or "")
                if mode and mode != "auto":
                    params["mode"] = mode      # сервер требует stream-up / packet-up
            if sni:
                params["sni"] = sni
            settings = ob.get("settings") or {}
            if proto == "vless":
                vnext = (settings.get("vnext") or [{}])[0]
                host = str(vnext.get("address") or "")
                port = vnext.get("port")
                users = vnext.get("users") or [{}]
                uid = str(users[0].get("id") or "")
                flow = str(users[0].get("flow") or "")
                if flow:
                    params["flow"] = flow
                encryption = str(users[0].get("encryption") or "").strip()
                if encryption and encryption.lower() != "none":
                    params["encryption"] = encryption
                userinfo = uid
            else:
                servers = (settings.get("servers") or [{}])[0]
                host = str(servers.get("address") or "")
                port = servers.get("port")
                userinfo = str(servers.get("password") or "")
            if not host or not port or not userinfo:
                continue
            query = "&".join(f"{k}={v}" for k, v in params.items() if v != "")
            frag = remark or f"{host}:{port}"
            if len(usable) > 1:
                frag = f"{frag} · {pos}"      # один профиль = несколько транспортов
            out.append(f"{proto}://{userinfo}@{host}:{port}?{query}#{frag}")
    return out


def decode_payload(text: str) -> list[str]:
    stripped = text.strip()
    if not stripped:
        return []
    if stripped[0] in "[{" and ("outbounds" in stripped or '"protocol"' in stripped):
        return xray_json_to_uris(stripped)
    if "://" in stripped:
        return [sanitize_line(x) for x in stripped.splitlines()]
    try:
        decoded = b64decode_loose(stripped).decode("utf-8", "replace")
    except (binascii.Error, ValueError):
        return []
    if decoded.strip()[:1] in "[{" and "outbounds" in decoded:
        return xray_json_to_uris(decoded)
    return [sanitize_line(x) for x in decoded.splitlines()]


# --------------------------------------------------------------------------- #
# validation
# --------------------------------------------------------------------------- #

def _query(parts) -> dict[str, str]:
    q = parse_qs(parts.query, keep_blank_values=True)
    return {k.lower(): (v[-1] if v else "").strip() for k, v in q.items()}


def validate_uri(uri: str, allowed: set[str], allow_private: bool = False) -> dict | None:
    """Return a normalised record, or None when the scheme is not wanted.

    `allow_private` is used for keys the owner wants copied verbatim: providers
    answer a block/limit with placeholder entries on a loopback address, and
    those must survive so the owner sees the same rows the official app shows.
    """
    if len(uri) < 12 or len(uri) > 4096:
        raise Bad("bad length")
    if any(ord(c) < 32 for c in uri):
        raise Bad("control characters")
    scheme = uri.split("://", 1)[0].lower()
    if scheme == "hy2":
        scheme = "hysteria2"
    if scheme not in allowed:
        return None
    parts = urlsplit(uri)
    try:
        host = (parts.hostname or "").strip("[]")
        port = parts.port
    except ValueError as exc:
        raise Bad(f"bad host/port: {exc}") from exc
    if not host:
        raise Bad("no host")
    if port is None or not (0 < port < 65536):
        raise Bad("bad port")
    if is_private_host(host) and not allow_private:
        raise Bad("private/loopback host")

    userinfo = unquote(parts.username or "")
    params = _query(parts)
    record: dict = {
        "uri": uri,
        "auth": userinfo,          # never printed; needed to run the config
        "proto": scheme,
        "host": host.lower(),
        "port": port,
        "security": "none",
        "network": "",
        "flow": "",
        "sni": "",
        "path": "",
        "host_header": "",
        "pbk": "",
        "sid": "",
        "fp": "",
        "alpn": "",
        "encryption": "",
        "xhttp_mode": "",
    }

    if scheme == "vless":
        if not UUID_RE.match(userinfo):
            raise Bad("vless id is not a UUID")
        encryption = (params.get("encryption") or "none").strip()
        if encryption.lower() in {"", "none"}:
            encryption = ""
        elif not ENCRYPTION_RE.match(encryption):
            raise Bad("bad vless encryption")
        security = params.get("security", "none").lower() or "none"
        if security not in SECURITIES:
            raise Bad(f"unknown security={security}")
        network = params.get("type", "tcp").lower() or "tcp"
        if network == "raw":
            network = "tcp"
        if network not in NETWORKS:
            raise Bad(f"unknown network={network}")
        flow = params.get("flow", "").lower()
        if flow not in FLOWS:
            raise Bad(f"unknown flow={flow}")
        pbk = params.get("pbk", "")
        if security == "reality" and len(pbk) < 20:
            raise Bad("reality without a valid pbk")
        record.update(
            security=security,
            network=network,
            flow=flow,
            sni=(params.get("sni") or params.get("host") or "").lower(),
            path=params.get("path", ""),
            host_header=params.get("host", "").lower(),
            pbk=pbk,
            sid=params.get("sid", ""),
            fp=params.get("fp", "").lower(),
            alpn=params.get("alpn", "").lower(),
            encryption=encryption,
            xhttp_mode=params.get("mode", ""),
        )
        if network == "grpc":
            record["path"] = params.get("servicename", "")
    elif scheme == "trojan":
        if not userinfo:
            raise Bad("trojan without password")
        security = params.get("security", "tls").lower() or "tls"
        if security not in SECURITIES:
            raise Bad("bad trojan security")
        record.update(security=security, sni=(params.get("sni") or "").lower(),
                      network=params.get("type", "tcp").lower())
    elif scheme == "vmess":
        try:
            blob = json.loads(b64decode_loose(uri.split("://", 1)[1].split("#", 1)[0]))
        except Exception as exc:                      # noqa: BLE001
            raise Bad("vmess payload is not base64 JSON") from exc
        if not isinstance(blob, dict) or not blob.get("id") or not blob.get("add"):
            raise Bad("incomplete vmess")
        record.update(host=str(blob["add"]).lower(), port=int(blob.get("port") or 0),
                      auth=str(blob["id"]),
                      security=str(blob.get("tls") or "none").lower(),
                      network=str(blob.get("net") or "tcp").lower(),
                      sni=str(blob.get("sni") or blob.get("host") or "").lower(),
                      path=str(blob.get("path") or ""))
    elif scheme == "ss":
        if not userinfo:
            raise Bad("ss without credentials")
    else:
        return None

    fp_parts = [
        scheme, record["host"], str(record["port"]), record["security"],
        record["network"], record["flow"], record["sni"], record["path"],
        record["host_header"], record["pbk"], record["sid"], record["fp"],
        record["alpn"], record.get("encryption", ""), record.get("xhttp_mode", ""),
        userinfo.lower(),
    ]
    record["fingerprint"] = hashlib.sha1(
        "|".join(fp_parts).encode("utf-8")
    ).hexdigest()
    return record


# --------------------------------------------------------------------------- #
# reachability probe
# --------------------------------------------------------------------------- #

async def probe(rec: dict, sem: asyncio.Semaphore, timeout: float) -> tuple[bool, float | None]:
    async with sem:
        started = time.perf_counter()
        writer = None
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(rec["host"], rec["port"]), timeout)
            del reader
            if rec["security"] in {"tls", "reality", "xtls"} and rec["sni"]:
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                await asyncio.wait_for(writer.start_tls(ctx, server_hostname=rec["sni"]), timeout)
            elapsed = (time.perf_counter() - started) * 1000.0
            return True, round(elapsed, 1)
        except Exception:                             # noqa: BLE001
            return False, None
        finally:
            if writer is not None:
                try:
                    writer.close()
                except Exception:                     # noqa: BLE001
                    pass


async def probe_all(records: list[dict], concurrency: int, timeout: float) -> None:
    sem = asyncio.Semaphore(max(1, concurrency))
    results = await asyncio.gather(*(probe(r, sem, timeout) for r in records))
    for rec, (ok, latency) in zip(records, results):
        rec["reachable"] = ok
        rec["latency_ms"] = latency


# --------------------------------------------------------------------------- #
# output
# --------------------------------------------------------------------------- #

def count_uris(path: str) -> int:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            body = fh.read()
    except OSError:
        return 0
    if "://" in body:
        return sum(1 for line in body.splitlines() if "://" in line)
    try:
        decoded = b64decode_loose(body).decode("utf-8", "replace")
    except (binascii.Error, ValueError):
        return 0
    return sum(1 for line in decoded.splitlines() if "://" in line)


def publish_commit(out_dir: str) -> None:
    """Persist the freshly built docs/ back to the repository (CI only).

    Two runners of the same workflow can overlap. Committing here, before the
    workflow's own "commit" step, means the later run re-applies the index onto
    the current remote tip instead of colliding with a fast-forward error.
    Failures are reported but never abort the build: publishing the site matters
    more than persisting the file, and the workflow step is still a fallback.
    """
    import subprocess

    def git(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], capture_output=True, text=True)

    if git("rev-parse", "--is-inside-work-tree").returncode != 0:
        print("[publish] not a git work tree -> skipped")
        return
    if git("config", "user.email").stdout.strip() == "":
        git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
        git("config", "user.name", "github-actions[bot]")

    branch = os.getenv("GITHUB_REF_NAME") or "main"
    for attempt in range(1, 4):
        git("fetch", "--quiet", "origin", branch)
        if git("reset", "--quiet", f"origin/{branch}").returncode != 0:
            print("[publish] reset onto origin failed -> left to the workflow step")
            return
        git("add", out_dir)
        if git("diff", "--staged", "--quiet").returncode == 0:
            print("[publish] no changes to commit")
            return
        git("commit", "--quiet", "-m", "chore: refresh subscription [skip ci]")
        push = git("push", "--quiet", "origin", f"HEAD:{branch}")
        if push.returncode == 0:
            print(f"[publish] committed on attempt {attempt}")
            return
        print(f"[publish] push attempt {attempt} rejected, retrying")
        time.sleep(6)
    print("[publish] WARNING: could not push; the workflow step will try again")


def write_atomic(path: str, content: str) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(content)
    os.replace(tmp, path)


def render_index(total: int, tiers: dict, built: str, sources: list[dict],
                 degraded: bool, deep: dict, ru_present: bool = False,
                 site_url: str = "") -> str:
    rows = "\n".join(
        f"<tr><td>{'ok' if s['ok'] else 'fail'}</td>"
        f"<td>{(s['name'] if s['ok'] else (s['name'] + ' — ' + str(s.get('error', ''))[:80]))}</td>"
        f"<td>{s['kept']}</td><td>{s['seen']}</td></tr>"
        for s in sources
    )
    if deep.get("available"):
        deep_line = (f"Соединение проверено прогоном трафика через Xray {deep.get('version', '')}: "
                     f"{deep.get('passed', 0)} из {deep.get('checked', 0)} конфигов реально "
                     f"пропустили HTTP-запрос.")
    else:
        deep_line = (f"Прогон трафика недоступен ({deep.get('reason', 'n/a')}) — "
                     f"порядок основан только на TCP/TLS-ответе.")
    note = ("<p class='warn'><b>Внимание:</b> проверка трафиком не выполнялась, "
            "список отсортирован по доступности порта.</p>" if degraded else "")
    ru_line = ("<li><b>sub-ru.txt</b> — <a href=\"sub-ru.txt\">список, проверенный из сети "
               "автора</a> (обновляется локальной сборкой, точнее для российских операторов)</li>"
               if ru_present else "")

    def install_link(file_name: str, title: str) -> str:
        target = quote(site_url + file_name, safe="")
        return f"v2rayng://install-sub?url={target}#{quote(title, safe='')}"

    if site_url:
        ru_btn = (f'<a class="btn" href="{install_link("sub-ru.txt", "Апельсинка впн")}">'
                  f'Добавить в v2rayNG</a>' if ru_present else "")
        cloud_btn = (f'<a class="btn ghost" href="{install_link("sub.txt", "Апельсинка впн (облако)")}">'
                     f'Облачный список</a>'
                     f'<a class="btn ghost" href="dashboard.html">Состояние ключей</a>')
    else:
        ru_btn = cloud_btn = ""
    return f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Апельсинка VPN — подписка</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;800&display=swap" rel="stylesheet">
<style>
:root{{--orange:#f97316;--deep:#7c2d12;--cream:#fff7ed}}
*{{box-sizing:border-box}}
body{{font-family:'Manrope',system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;
background:radial-gradient(1200px 600px at 10% -10%,#ffedd5 0%,#fff 55%);color:#1c1917}}
.wrap{{max-width:760px;margin:0 auto;padding:56px 20px 72px}}
h1{{font-weight:800;font-size:clamp(30px,6vw,46px);letter-spacing:-.02em;margin:0 0 8px}}
h1 span{{color:var(--orange)}}
p.lead{{color:#57534e;margin:0 0 28px;font-size:17px}}
.card{{background:#fff;border:1px solid #fed7aa;border-radius:18px;padding:22px 24px;
box-shadow:0 10px 30px rgba(249,115,22,.08);margin-bottom:18px}}
a{{color:var(--orange);font-weight:600}}
code{{background:var(--cream);padding:3px 8px;border-radius:7px;word-break:break-all;
font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px}}
table{{border-collapse:collapse;width:100%;margin-top:6px;font-size:14px}}
th{{text-align:left;font-weight:600;color:#78716c;text-transform:uppercase;font-size:11px;
letter-spacing:.08em;padding:6px 8px;border-bottom:2px solid #fed7aa}}
td{{border-bottom:1px solid #f5f5f4;padding:7px 8px}}
.muted{{color:#78716c;font-size:13px;line-height:1.6}}
.warn{{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:12px 16px;
border-radius:12px;font-size:14px}}
.btns{{margin:0 0 16px}}
.btn{{display:inline-block;background:var(--orange);color:#fff;text-decoration:none;
padding:12px 22px;border-radius:12px;font-weight:700;margin:0 10px 10px 0}}
.btn.ghost{{background:#fff;color:var(--orange);border:1px solid #fdba74}}
.pill{{display:inline-block;background:var(--cream);border:1px solid #fed7aa;border-radius:999px;
padding:5px 14px;font-size:13px;font-weight:600;color:var(--deep);margin:0 8px 8px 0}}
</style></head><body><div class="wrap">
<h1>Апельсинка <span>VPN</span></h1>
<p class="lead">Одна подписка для v2rayNG: твои ключи сверху, публичные узлы — в конце.</p>
{note}
<div class="card">
<p style="margin:0 0 10px"><b>Ссылка для клиента</b></p>
<p class="btns">{ru_btn}{cloud_btn}</p>
<p style="margin:0 0 14px"><code><a href="sub.txt">sub.txt</a></code></p>
<ul style="margin:0;padding-left:20px;line-height:1.9">
<li><b>sub.txt</b> — всё, что прошло проверку синтаксиса, {total}</li>
<li><b>sub-plain.txt</b> — тот же список построчно</li>
{ru_line}
<li><b><a href="dashboard.html">dashboard.html</a></b> — трафик и срок действия каждого ключа</li>
<li><b>status.json</b> — три уровня диагностики и состояние источников</li>
</ul>
</div>
<div class="card">
<p style="margin:0 0 10px"><b>Как проверялись узлы</b></p>
<span class="pill">конфигурация корректна: {tiers['syntax_only'] + tiers['port_only'] + tiers['verified']}</span>
<span class="pill">порт доступен: {tiers['port_only'] + tiers['verified']}</span>
<span class="pill">VPN-соединение проверено: {tiers['verified']}</span>
<p class="muted" style="margin:12px 0 0">{deep_line} Узлы без пометки проверки стоят ниже:
их никто не назвал мёртвыми, просто соединение не подтверждено.</p>
</div>
<div class="card">
<p style="margin:0 0 6px"><b>Источники</b></p>
<table><tr><th>источник</th><th>в подписке</th><th>получено</th></tr>{rows}</table>
</div>
<p class="muted">Сборка: {built}. Конфиги публичных источников принадлежат третьим лицам,
их работа из вашей сети не гарантируется.</p>
</div></body></html>
"""


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sources", default="sources.txt")
    ap.add_argument("--out", default="docs")
    ap.add_argument("--prev", default="docs/sub.txt")
    ap.add_argument("--timeout", type=float, default=30.0, help="per-source HTTP timeout")
    ap.add_argument("--probe-timeout", type=float, default=4.0)
    ap.add_argument("--probe-concurrency", type=int, default=48)
    ap.add_argument("--max-configs", type=int, default=int(os.getenv("MAX_CONFIGS", "1200")))
    ap.add_argument("--max-per-key", type=int, default=int(os.getenv("MAX_PER_KEY", "15")),
                    help="how many nodes to keep per key block (0 = all)")
    ap.add_argument("--min-configs", type=int, default=int(os.getenv("MIN_CONFIGS", "20")))
    ap.add_argument("--max-per-host", type=int, default=int(os.getenv("MAX_PER_HOST", "4")))
    ap.add_argument("--allow-protocols", default=os.getenv("ALLOW_PROTOCOLS", "vless"))
    ap.add_argument("--no-probe", action="store_true", help="skip reachability probe")
    ap.add_argument("--site-url", default=os.getenv("SITE_URL",
                    "https://kot53094-creator.github.io/vless-sub/"),
                    help="public base URL, used to build v2rayNG install links")
    ap.add_argument("--no-dividers", action="store_true",
                    help="do not add the '--- K1 ... ---' separator entries")
    ap.add_argument("--no-deep", action="store_true",
                    help="skip the Xray traffic test (nothing is proven to work then)")
    ap.add_argument("--deep-workers", type=int, default=int(os.getenv("DEEP_WORKERS", "16")))
    ap.add_argument("--deep-timeout", type=float, default=float(os.getenv("DEEP_TIMEOUT", "5")))
    ap.add_argument("--deep-limit", type=int, default=int(os.getenv("DEEP_LIMIT", "0")),
                    help="cap how many configs get the traffic test (0 = all reachable)")
    ap.add_argument("--force", action="store_true", help="publish even if the result shrank")
    ap.add_argument("--dry-run", action="store_true", help="print stats, write nothing")
    ap.add_argument("--no-publish-commit", action="store_true",
                    help="do not commit docs/ to git even when running in CI")
    return ap.parse_args(argv)


def scrub(text: str, src: dict) -> str:
    """Remove the private URL and its token from an error message before logging."""
    text = str(text)
    if not src.get("private"):
        return text[:160]
    url = src["url"]
    token = url.rstrip("/").rsplit("/", 1)[-1]
    host = url.split("://", 1)[-1].split("/", 1)[0]
    for part in (url, token, host):
        if part:
            text = text.replace(part, "<private>")
    return text[:160]


def load_sources(path: str) -> list[dict]:
    items: list[dict] = []
    with open(path, "r", encoding="utf-8-sig") as fh:
        for raw in fh:
            line = raw.strip().lstrip("\ufeff").strip()
            if not line or line.startswith("#"):
                continue
            label = ""
            target = line
            # `LABEL|url` turns the source into its own key block (K1, K2, ...)
            is_raw = False
            is_quiet = False
            note = ""
            order = 0
            if "|" in line and "://" not in line.split("|", 1)[0]:
                parts = [p.strip() for p in line.split("|")]
                label_raw = parts[0]
                target = parts[1] if len(parts) > 1 else ""
                note = "|".join(parts[2:]).strip() if len(parts) > 2 else ""
                match = re.match(r"^(.*?):(\d+)$", label_raw)
                if match:
                    label_raw, order = match.group(1), int(match.group(2))
                is_raw = label_raw.endswith("!")
                # `~Label` = quiet: no placeholder row when the provider is silent
                is_quiet = label_raw.strip().startswith("~")
                label = re.sub(r"[^A-Za-z0-9 ]", "", label_raw).upper()[:8]
                note = note[:40]
            items.append({"url": target, "name": target.split("://", 1)[-1][:70],
                          "private": bool(label), "label": label, "note": note,
                          "order": order, "raw": is_raw, "quiet": is_quiet,
                          "title": f"<{label.lower()}>" if label else ""})
    return items


def label_from(url: str) -> str:
    """Short provider tag shown in v2rayNG, e.g. aidenvpn.com -> AID."""
    host = (urlsplit(url).hostname or "key").lower()
    parts = [p for p in host.split(".") if p not in ("www", "api", "sub", "conf")]
    core = parts[0] if parts else host
    return re.sub(r"[^A-Za-z0-9]", "", core).upper()[:4] or "KEY"


def parse_private(raw: str) -> list[dict]:
    """`LABEL|https://...` entries, separated by comma, space or newline."""
    out: list[dict] = []

    def add(label_raw: str, url: str, note: str) -> None:
        url = url.strip()
        if "://" not in url:
            return
        order = 0
        match = re.match(r"^(.*?):(\d+)$", label_raw.strip())
        if match:
            label_raw, order = match.group(1), int(match.group(2))
        # `Label!|url` copies the key verbatim: no checks, no renaming.
        is_raw = label_raw.strip().endswith("!")
        # `~Label|url` stays silent when the provider returns no configs
        is_quiet = label_raw.strip().startswith("~")
        label = re.sub(r"[^A-Za-z0-9 ]", "", label_raw).strip().upper()[:8] or label_from(url)
        # `...|note ua=Happ/2.9.1 hwid=<id>` — панели, которые отдают конфиги
        # только своему приложению, узнают клиента по этим заголовкам.
        headers: dict[str, str] = {}
        words: list[str] = []
        for token in note.split():
            low = token.lower()
            if low.startswith("ua="):
                headers["User-Agent"] = token[3:]
            elif low.startswith("hwid="):
                headers["x-hwid"] = token[5:]
                headers.setdefault("x-device-os", "Windows")
                headers.setdefault("x-ver-os", "10.0")
                headers.setdefault("x-device-model", "PC")
            else:
                words.append(token)
        out.append({"url": url, "label": label, "raw": is_raw, "quiet": is_quiet,
                    "note": " ".join(words)[:40], "headers": headers, "order": order})

    tokens: list[str] = []
    for chunk in re.split(r"[,\n]+", raw):
        # a whole list joined by spaces (old format) still has one "://" per entry
        tokens.extend(chunk.split() if chunk.count("://") > 1 else [chunk])

    for token in tokens:
        token = token.strip()
        if not token:
            continue
        if "|" not in token:
            for bare in token.split():          # backward compatible: bare URLs
                add("", bare, "")
            continue
        parts = token.split("|")
        add(parts[0], parts[1] if len(parts) > 1 else "",
            "|".join(parts[2:]) if len(parts) > 2 else "")
    return out


def profile_of(rec: dict) -> str:
    """Имя профиля из ответа провайдера, без служебного номера выхода.

    `🇫🇮 Финляндия · 3` и `🇫🇮 Финляндия · 7` — один и тот же профиль,
    в списке от него нужен только самый быстрый выход.
    """
    frag = rec.get("uri", "")
    if "#" not in frag:
        return ""
    name = unquote(frag.split("#", 1)[1])
    return re.sub(r"\s*·\s*\d+$", "", name).strip()


GENERIC_PROFILE_MARKS = ("АВТО", "БЕЗЛИМИТ", "ЛИМИТНЫЕ", "Обход", "AUTO")


def is_generic_profile(name: str) -> bool:
    """Служебные профили провайдера: в них собраны серверы со всех стран."""
    return any(mark.lower() in name.lower() for mark in GENERIC_PROFILE_MARKS)


def with_remark(uri: str, remark: str) -> str:
    """Replace only the #fragment: connection parameters stay byte-identical."""
    base = uri.split("#", 1)[0]
    return f"{base}#{remark}"


def plural(n: int, one: str, few: str, many: str) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def notice_uri(remark: str) -> str:
    """A syntactically valid VLESS entry that only carries a message.

    Providers that hit a daily limit often answer with an empty list, and then
    the group in v2rayNG simply disappears. Such an entry keeps the group
    visible with an explanation instead of nothing.
    """
    null_uuid = "00000000-0000-0000-0000-000000000000"
    return f"vless://{null_uuid}@0.0.0.0:1?encryption=none&security=none&type=tcp#{remark}"


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    allowed = {p.strip().lower() for p in args.allow_protocols.split(",") if p.strip()}
    started_wall = datetime.now(timezone.utc)
    print(f"[build] start {started_wall.isoformat(timespec='seconds')} "
          f"protocols={sorted(allowed)}")

    sources = load_sources(args.sources)
    private_raw = (os.getenv("PRIVATE_SUB_URL") or "").strip()
    include_private = (os.getenv("INCLUDE_PRIVATE") or "").strip().lower() in {"1", "true", "yes"}
    # Several private subscriptions may be listed in one secret, separated by
    # comma, space or newline.
    private_urls = parse_private(private_raw)
    if private_urls and include_private:
        for index, item in enumerate(private_urls, 1):
            sources.append({"url": item["url"], "name": f"private-{index}", "private": True,
                            "index": item.get("order") or index, "label": item["label"],
                            "raw": item["raw"], "quiet": item.get("quiet", False),
                            "order": item.get("order", 0),
                            "note": item.get("note", ""),
                            "headers": item.get("headers", {}),
                            "title": f"<private-{index} {item['label']}>"})

    # Labelled entries in sources.txt (e.g. `KAVKAZ|file:configs/kavkaz.txt`) become
    # their own key blocks after the secret-provided ones.
    next_index = max([s.get("index", 0) for s in sources] + [0]) + 1
    for src in sources:
        if src.get("label") and not src.get("index"):
            src["index"] = src.get("order") or next_index
            next_index = max(next_index, src["index"]) + 1

    if private_urls and include_private:
        print(f"[build] private sources: {len(private_urls)} enabled "
              f"({', '.join(i['label'] for i in private_urls)}; "
              f"their content will be PUBLIC in the result)")
    elif private_urls:
        print(f"[build] private sources: {len(private_urls)} configured but "
              f"INCLUDE_PRIVATE is not set -> skipped")

    all_records: list[dict] = []
    status: list[dict] = []
    for src in sources:
        entry = {"name": (src.get("title") or "<private>") if src["private"] else src["name"],
                 "ok": False, "seen": 0, "kept": 0, "error": "",
                 "label": src.get("label") or "", "note": src.get("note") or "",
                 "order": src.get("index") or 0, "quota": {}, "provider": ""}
        try:
            text, headers = fetch_meta(src["url"], timeout=args.timeout,
                                       extra=src.get("headers"))
            entry["quota"] = parse_userinfo(headers.get("subscription-userinfo", ""))
            entry["provider"] = decode_title(headers.get("profile-title", ""))
            lines = decode_payload(text)
            seen = 0
            kept = 0
            reasons: Counter = Counter()
            for line in lines:
                if "://" not in line:
                    continue
                seen += 1
                try:
                    rec = validate_uri(line, allowed, allow_private=bool(src.get("raw")))
                except Bad as exc:
                    reasons[str(exc)] += 1
                    # Providers answer a limit / client block with placeholder
                    # entries on a loopback address. Keep them: their remark is
                    # the provider's own explanation shown to the user.
                    if src["private"] and "private/loopback" in str(exc):
                        entry.setdefault("stubs", [])
                        if len(entry["stubs"]) < 6:
                            entry["stubs"].append(line)
                    continue
                except Exception as exc:                  # noqa: BLE001
                    reasons[type(exc).__name__] += 1
                    continue
                if rec is None:
                    reasons["other protocol"] += 1
                    continue
                rec["origin"] = entry["name"]
                rec["from_private"] = bool(src["private"])
                rec["group"] = src.get("index", 999)
                rec["label"] = src.get("label", "FREE")
                rec["no_prefix"] = bool(src.get("raw"))   # copy the provider's own remark
                all_records.append(rec)
                kept += 1
            entry.update(ok=True, seen=seen, kept=kept)
            top = ", ".join(f"{k}:{v}" for k, v in reasons.most_common(3))
            print(f"[source] ok kept={kept}/{seen} {entry['name'][:60]}"
                  + (f" (dropped {top})" if top else ""))
        except FetchError as exc:
            entry["error"] = scrub(str(exc), src)
            print(f"[source] FAIL {entry['name'][:60]} -> {entry['error'][:90]}")
        except Exception as exc:                          # noqa: BLE001
            entry["error"] = scrub(f"{type(exc).__name__}: {exc}", src)
            print(f"[source] FAIL {entry['name'][:60]} -> {entry['error'][:90]}")
        status.append(entry)

    ok_sources = [s for s in status if s["ok"]]
    if not ok_sources:
        print("[build] ABORT: no source could be read; previous result left untouched")
        return 2

    # ---- deduplicate -------------------------------------------------------
    uniq: dict[str, dict] = {}
    exact: set[str] = set()
    names: dict[str, str] = {}          # fingerprint -> самое точное имя профиля
    dups = 0
    for rec in all_records:
        fp = rec["fingerprint"]
        if rec.get("from_private") and not is_generic_profile(profile_of(rec)):
            names.setdefault(fp, profile_of(rec))
        if rec["uri"] in exact:
            dups += 1
            continue
        exact.add(rec["uri"])
        if fp in uniq:
            dups += 1
            # a node that is also in the private subscription keeps its priority
            if rec.get("from_private"):
                uniq[fp]["from_private"] = True
            continue
        uniq[fp] = rec
    records = list(uniq.values())
    # Провайдер перечисляет одни и те же серверы и в общем профиле «АВТО», и в
    # страновых. Дедупликация оставляла имя «АВТО» — вернём стране её название.
    renamed = 0
    for rec in records:
        better = names.get(rec["fingerprint"])
        if better and rec.get("from_private") and "#" in rec["uri"]:
            if profile_of(rec) != better:
                rec["uri"] = with_remark(rec["uri"], better)
                renamed += 1
    if renamed:
        print(f"[dedup] {renamed} узлов получили страновые имена")
    print(f"[dedup] {len(all_records)} -> {len(records)} ({dups} duplicates removed)")

    # ---- per-host cap ------------------------------------------------------
    per_host: Counter = Counter()
    capped: list[dict] = []
    for rec in records:
        if rec["host"] in {"0.0.0.0", "::"} or rec.get("no_prefix"):
            capped.append(rec)             # placeholders and verbatim keys are never capped
            continue
        per_host[rec["host"]] += 1
        if per_host[rec["host"]] > args.max_per_host:
            continue
        capped.append(rec)
    records = capped
    print(f"[cap] {len(records)} configs, max {args.max_per_host} per host")

    # ---- reachability ------------------------------------------------------
    if args.no_probe:
        for rec in records:
            rec["reachable"] = None
            rec["latency_ms"] = None
        print("[probe] skipped")
    else:
        t0 = time.perf_counter()
        asyncio.run(probe_all(records, args.probe_concurrency, args.probe_timeout))
        alive = sum(1 for r in records if r["reachable"])
        print(f"[probe] reachable {alive}/{len(records)} "
              f"in {time.perf_counter() - t0:.1f}s")

    # ---- deep check: push real HTTP traffic through every candidate ---------
    deep = {"available": False, "reason": "disabled", "checked": 0, "passed": 0}
    deep_enabled = (not args.no_deep) and (
        os.getenv("DEEP_TEST", "1").strip().lower() not in {"0", "false", "no"}
    )
    if deep_enabled and not args.no_probe:
        subset = [r for r in records if r["reachable"]]
        # Fair order: own nodes first, then a stable shuffle. Sorting by TCP latency
        # would spend the whole budget on CDN edges that answer the handshake and
        # then drop the tunnel -- exactly the configs this stage must get rid of.
        subset.sort(key=lambda r: (0 if r.get("from_private") else 1,
                                   hashlib.sha1(r["fingerprint"].encode()).hexdigest()))
        if args.deep_limit:
            subset = subset[: args.deep_limit]
        print(f"[deep] traffic test for {len(subset)} configs "
              f"(xray {xray_check.XRAY_VERSION}, {args.deep_workers} workers)")
        deep = xray_check.run_deep_check(
            subset, workers=args.deep_workers, timeout=args.deep_timeout
        )
        if deep["available"]:
            print(f"[deep] passed {deep['passed']}/{deep['checked']} "
                  f"in {deep.get('seconds', 0)}s")
        else:
            print(f"[deep] UNAVAILABLE ({deep['reason']}) -> falling back to TCP results")
    elif not deep_enabled:
        print("[deep] disabled by request")

    for rec in records:
        rec.setdefault("deep_ok", None)
        rec.setdefault("deep_latency_ms", None)

    # ---- ordering: own keys first (K1, K2, ...), free sources at the very end
    def tier(rec: dict) -> int:
        if rec.get("deep_ok") is True:
            return 0          # traffic actually passed through the node
        if rec["reachable"]:
            return 1          # port answered, proxy behaviour not proven
        return 2              # did not answer at all

    def rank(rec: dict) -> tuple:
        grp = rec.get("group", 999)
        owned = 0 if rec.get("from_private") else 1
        dlat = rec["deep_latency_ms"] if rec.get("deep_latency_ms") is not None else 9e9
        lat = rec["latency_ms"] if rec["latency_ms"] is not None else 9e9
        return (owned, grp, tier(rec), dlat, lat, rec["host"])

    records.sort(key=rank)

    # Brand the remark only: the #fragment is a label, every connection
    # parameter of the key stays byte-identical.
    for rec in records:
        if rec.get("no_prefix"):
            rec["out_uri"] = rec["uri"]        # verbatim, exactly as the provider sent it
            continue
        prefix = f"K{rec['group']} {rec['label']}" if rec.get("from_private") else "FREE"
        old = unquote(rec["uri"].split("#", 1)[1]) if "#" in rec["uri"] else ""
        rec["out_uri"] = with_remark(rec["uri"], f"{prefix} · {old or rec['host']}")

    # A provider that hit a daily limit answers with an empty list; without a
    # placeholder the whole group vanishes from v2rayNG with no explanation.
    notices: list[dict] = []
    dividers: list[dict] = []
    for src in sources:
        if not src["private"]:
            continue
        title = src.get("title") or "<private>"
        entry = next((s for s in status if s["name"] == title), None)
        if not entry or not entry["ok"]:
            continue
        tag = f"K{src['index']} {src['label']}"
        if not args.no_dividers and not (src.get("quiet") and entry["kept"] == 0):
            color = KEY_COLORS[(src["index"] - 1) % len(KEY_COLORS)]
            note = (src.get("note") or "").strip()
            if entry["kept"]:
                count = f"{entry['kept']} {plural(entry['kept'], 'узел', 'узла', 'узлов')}"
                tail = f"{note} · {count}" if note else count
            else:
                tail = note or "нет доступа"
            dividers.append({"group": src["index"], "proto": "vless", "host": "",
                             "tag": tag, "color": color, "note": note,
                             "out_uri": notice_uri(f"{color} ━━━ {tag} · {tail} ━━━"),
                             "uri": "", "notice": True})
        if entry["kept"] == 0 and not src.get("quiet"):
            stubs = entry.get("stubs") or []
            for line in stubs:
                name = unquote(line.split("#", 1)[1]) if "#" in line else "нет доступа"
                notices.append({"group": src["index"], "notice": True, "proto": "vless",
                                "out_uri": with_remark(line, f"{tag} · {name}"),
                                "uri": name, "host": ""})
            if not stubs:
                remark = f"{tag} · ⏳ серверы появятся позже"
                notices.append({"group": src["index"], "notice": True, "proto": "vless",
                                "out_uri": notice_uri(remark), "uri": remark, "host": ""})
            print(f"[notice] {src['label']}: no configs -> "
                  f"{len(stubs) or 1} placeholder(s) from the provider")
        entry.pop("stubs", None)          # raw placeholders stay out of status.json

    for div in dividers:
        div["from_private"] = True
    ordered: list[dict] = []
    groups = sorted({r["group"] for r in records if r.get("from_private")}
                    | {n["group"] for n in notices}
                    | {d["group"] for d in dividers})
    for idx in groups:
        ordered += [d for d in dividers if d["group"] == idx]
        ordered += [n for n in notices if n["group"] == idx]
        ordered += [r for r in records if r.get("from_private") and r["group"] == idx]

    free = [r for r in records if not r.get("from_private")]
    free_divider = None
    if free and dividers:
        free_divider = {"group": 999, "proto": "vless", "host": "", "uri": "",
                        "out_uri": notice_uri(f"{FREE_COLOR} ━━━ FREE ━━━")}
        ordered.append(free_divider)
    ordered += free

    working = [r for r in records if r.get("deep_ok") is True]
    reachable = [r for r in records if r["reachable"]]
    verified_by_origin = Counter(r["origin"] for r in working)
    for entry in status:
        entry["verified"] = verified_by_origin.get(entry["name"], 0)
    degraded = not deep["available"] and not args.no_probe

    # Keep each key block short: the client list should look like a paid service,
    # not like a dump of 77 entries. Nodes are already sorted best-first.
    if args.max_per_key:
        counted: dict = {}
        per_profile: Counter = Counter()
        trimmed: list[dict] = []
        for rec in ordered:
            if rec.get("from_private") and rec.get("host"):
                used = counted.get(rec["group"], 0)
                if used >= args.max_per_key:
                    continue
                # Один сервер на профиль провайдера: иначе быстрые «АВТО»-
                # выходы вытесняют весь список и в клиенте видно 15 одинаковых
                # строк вместо Финляндии, Германии, США.
                prof = profile_of(rec)
                if prof and per_profile[(rec["group"], prof)] >= 1:
                    continue
                counted[rec["group"]] = used + 1
                if prof:
                    per_profile[(rec["group"], prof)] += 1
            trimmed.append(rec)
        ordered = trimmed

    owned_all = [r for r in ordered if r.get("from_private") or r.get("notice")]
    free_all = [r for r in ordered if not (r.get("from_private") or r.get("notice"))]
    room = max(0, args.max_configs - len(owned_all))
    selected = owned_all + free_all[:room]

    # Divider captions must match what was actually published, not what the
    # provider returned: --max-per-key trims every block.
    shown_by_group = Counter(r["group"] for r in selected
                             if r.get("host") and r.get("from_private"))
    for div in dividers:
        count = shown_by_group.get(div["group"], 0)
        if count:
            tail = f"{count} {plural(count, 'узел', 'узла', 'узлов')}"
            if div.get("note"):
                tail = f"{div['note']} · {tail}"
        else:
            tail = div.get("note") or "нет доступа"
        div["out_uri"] = notice_uri(f"{div['color']} ━━━ {div['tag']} · {tail} ━━━")

    # The divider must show how many free nodes actually made it past the cap.
    if free_divider is not None:
        shown = sum(1 for r in selected
                    if r.get("host") and not r.get("from_private") and r is not free_divider)
        free_divider["out_uri"] = notice_uri(
            f"{FREE_COLOR} ━━━ FREE · {shown} "
            f"{plural(shown, 'публичный узел', 'публичных узла', 'публичных узлов')} ━━━")

    # ---- safety gate -------------------------------------------------------
    prev_count = count_uris(args.prev) if os.path.exists(args.prev) else 0
    reason = ""
    if len(selected) < args.min_configs:
        reason = f"only {len(selected)} configs (min {args.min_configs})"
    elif prev_count and len(selected) < prev_count * 0.5:
        reason = f"count dropped {prev_count} -> {len(selected)} (<50%)"
    if reason and not args.force:
        print(f"[guard] ABORT: {reason}; keeping the previous subscription")
        return 3
    if reason:
        print(f"[guard] WARNING: {reason}; --force given, publishing anyway")

    if degraded:
        print("[probe] WARNING: traffic test unavailable; order is based on TCP only")

    payload = "\n".join(r["out_uri"] for r in selected) + "\n"

    if args.dry_run:
        print(f"[dry-run] would publish {len(selected)} configs "
              f"({len(working)} working, {len(records)} valid overall), "
              f"{len(payload)} bytes")
        return 0

    # ---- write -------------------------------------------------------------
    os.makedirs(args.out, exist_ok=True)
    write_atomic(os.path.join(args.out, "sub.txt"), b64encode_std(payload))
    write_atomic(os.path.join(args.out, "sub-plain.txt"), payload)
    write_atomic(os.path.join(args.out, ".nojekyll"), "")
    for legacy in ("sub-verified.txt", "sub-all.txt"):   # older layout
        path = os.path.join(args.out, legacy)
        if os.path.exists(path):
            os.remove(path)

    by_proto = Counter(r["proto"] for r in selected)
    tiers = {
        "verified": len(working),
        "port_only": sum(1 for r in records
                         if r["reachable"] and r.get("deep_ok") is not True),
        "syntax_only": sum(1 for r in records if not r["reachable"]),
        "notices": len(notices),
    }
    meta = {
        "built_at": started_wall.isoformat(timespec="seconds"),
        "brand": "Апельсинка VPN",
        "configs": len(selected),
        "working_total": len(working),
        "reachable_total": len(reachable),
        "valid_total": len(records),
        "tiers": tiers,
        "probe_degraded": degraded,
        "deep_test": deep,
        "duplicates_removed": dups,
        "protocols": dict(by_proto),
        "allowed_protocols": sorted(allowed),
        "max_configs": args.max_configs,
        "previous_configs": prev_count,
        "probe": "skipped" if args.no_probe else "tcp/tls handshake",
        "sources": status,
    }
    write_atomic(os.path.join(args.out, "status.json"),
                 json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
    write_atomic(os.path.join(args.out, "index.html"),
                 render_index(len(selected), tiers, meta["built_at"], status,
                              degraded, deep,
                              os.path.exists(os.path.join(args.out, "sub-ru.txt")),
                              args.site_url))
    worker_url = ""
    worker_file = os.path.join("configs", "worker.txt")
    if os.path.exists(worker_file):
        worker_url = open(worker_file, encoding="utf-8-sig").read().strip().rstrip("/")
    write_atomic(os.path.join(args.out, "dashboard.html"),
                 dashboard.render(status, meta["built_at"], len(selected),
                                  tiers, args.site_url, worker_url))
    print(f"[done] published {len(selected)} configs "
          f"(verified {tiers['verified']}, port-only {tiers['port_only']}, "
          f"unreachable {tiers['syntax_only']}) -> {args.out}")

    if os.getenv("GITHUB_ACTIONS") == "true" and not args.no_publish_commit:
        publish_commit(args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
