#!/usr/bin/env python3
"""Deep check: start a real Xray client for a single config and pass HTTP through it.

Why this exists
---------------
"Port answered a TCP/TLS handshake" says nothing about whether a proxy works:
the UUID may be revoked, the REALITY key wrong, the node rate-limited or the
outbound blocked. The only honest test is to run the config and push traffic
through it.

What it downloads
-----------------
One official Xray-core release, pinned by version AND sha256 (the same hash the
project publishes in its .dgst file). Nothing else is fetched, and the archive is
verified before it is unpacked. Set DEEP_TEST=0 to skip this stage entirely.

Configs are never executed: they are serialised into an Xray JSON config, so a
malicious hostname or path is just data.
"""

from __future__ import annotations

import asyncio
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

XRAY_VERSION = "v26.3.27"
XRAY_ASSETS = {
    "linux": ("Xray-linux-64.zip", "23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae"),
    "windows": ("Xray-windows-64.zip", "d004c39288ce9ada487c6f398c7c545f7d749e44bdfdd59dbc9f865afba4e1ad"),
}
RELEASE_URL = "https://github.com/XTLS/Xray-core/releases/download/{ver}/{asset}"
# One target only: a second attempt doubles the cost of every dead node, and the
# list is dominated by dead nodes. Cloudflare answers 204 without any payload.
PROBE_TARGET = "http://cp.cloudflare.com/generate_204"
SUPPORTED_PROTOCOLS = {"vless", "vmess", "trojan", "ss"}
ACCEPT_NETWORKS = {"tcp", "ws", "grpc", "h2", "http", "xhttp", "splithttp", "httpupgrade"}


class XrayUnavailable(Exception):
    """Binary could not be obtained or started; the caller should degrade."""


def _platform_key() -> str:
    if sys.platform.startswith("linux"):
        return "linux"
    if sys.platform.startswith("win"):
        return "windows"
    raise XrayUnavailable(f"no pinned Xray build for {sys.platform}")


def _sha256(path: str) -> str:
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_xray(cache_dir: str | None = None) -> str:
    """Return a path to a verified xray binary, downloading it once if needed."""
    key = _platform_key()
    asset, expected = XRAY_ASSETS[key]
    cache_dir = cache_dir or os.path.join(tempfile.gettempdir(), "xray-cache")
    os.makedirs(cache_dir, exist_ok=True)
    binary = os.path.join(cache_dir, "xray.exe" if key == "windows" else "xray")
    marker = os.path.join(cache_dir, "version.txt")

    if os.path.exists(binary) and os.path.exists(marker):
        with open(marker, "r", encoding="utf-8") as fh:
            if fh.read().strip() == XRAY_VERSION:
                return binary

    archive = os.path.join(cache_dir, asset)
    url = RELEASE_URL.format(ver=XRAY_VERSION, asset=asset)
    try:
        urllib.request.urlretrieve(url, archive)
    except Exception as exc:                              # noqa: BLE001
        raise XrayUnavailable(f"download failed: {type(exc).__name__}") from exc

    actual = _sha256(archive)
    if actual != expected:
        os.remove(archive)
        raise XrayUnavailable("sha256 mismatch for the Xray archive")

    with zipfile.ZipFile(archive) as zf:
        for member in zf.namelist():
            if os.path.basename(member) in {"xray", "xray.exe"}:
                with zf.open(member) as src, open(binary, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                break
        else:
            raise XrayUnavailable("xray binary missing inside the archive")
    os.remove(archive)
    if key != "windows":
        os.chmod(binary, 0o755)
    with open(marker, "w", encoding="utf-8") as fh:
        fh.write(XRAY_VERSION)
    return binary


def _tcp_settings(rec: dict) -> dict:
    net = rec["network"] or "tcp"
    stream: dict = {"network": net, "security": rec["security"] or "none"}

    if net == "ws":
        ws = {"path": rec["path"] or "/"}
        if rec["host_header"]:
            ws["headers"] = {"Host": rec["host_header"]}
        stream["wsSettings"] = ws
    elif net == "grpc":
        stream["grpcSettings"] = {"serviceName": rec["path"] or "", "multiMode": False}
    elif net in {"xhttp", "splithttp"}:
        xh = {"path": rec["path"] or "/"}
        if rec.get("xhttp_mode"):
            xh["mode"] = rec["xhttp_mode"]
        if rec["host_header"]:
            xh["host"] = rec["host_header"]
        stream["network"] = "xhttp"
        stream["xhttpSettings"] = xh
    elif net == "httpupgrade":
        hu = {"path": rec["path"] or "/"}
        if rec["host_header"]:
            hu["host"] = rec["host_header"]
        stream["httpUpgradeSettings"] = hu
    elif net in {"h2", "http"}:
        h2 = {"path": rec["path"] or "/"}
        if rec["host_header"]:
            h2["host"] = [rec["host_header"]]
        stream["network"] = "h2"
        stream["httpSettings"] = h2

    if rec["security"] == "tls":
        tls = {"serverName": rec["sni"] or rec["host"], "allowInsecure": False}
        if rec["fp"]:
            tls["fingerprint"] = rec["fp"]
        if rec["alpn"]:
            tls["alpn"] = [a.strip() for a in rec["alpn"].split(",") if a.strip()]
        stream["tlsSettings"] = tls
    elif rec["security"] == "reality":
        stream["realitySettings"] = {
            "serverName": rec["sni"] or rec["host"],
            "publicKey": rec["pbk"],
            "shortId": rec["sid"],
            "fingerprint": rec["fp"] or "chrome",
            "spiderX": "/",
        }
    return stream


def build_config(rec: dict, listen_port: int) -> dict:
    proto = rec["proto"]
    if proto == "vless":
        user = {"id": rec["auth"], "encryption": rec.get("encryption") or "none"}
        if rec["flow"]:
            user["flow"] = rec["flow"]
        out = {"protocol": "vless",
               "settings": {"vnext": [{"address": rec["host"], "port": rec["port"],
                                       "users": [user]}]}}
    elif proto == "vmess":
        out = {"protocol": "vmess",
               "settings": {"vnext": [{"address": rec["host"], "port": rec["port"],
                                       "users": [{"id": rec["auth"], "alterId": 0,
                                                  "security": "auto"}]}]}}
    elif proto == "trojan":
        out = {"protocol": "trojan",
               "settings": {"servers": [{"address": rec["host"], "port": rec["port"],
                                         "password": rec["auth"]}]}}
    elif proto == "ss":
        out = {"protocol": "shadowsocks",
               "settings": {"servers": [{"address": rec["host"], "port": rec["port"],
                                         "method": rec["method"],
                                         "password": rec["password"]}]}}
    else:
        raise ValueError(f"deep check does not support {proto}")
    if proto != "ss":
        out["streamSettings"] = _tcp_settings(rec)
    return {
        "log": {"loglevel": "none"},
        "inbounds": [{
            "tag": "probe-in",
            "listen": "127.0.0.1",
            "port": listen_port,
            "protocol": "http",
            "settings": {"auth": "noauth", "allowTransparent": False},
        }],
        "outbounds": [out],
    }


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _wait_port(port: int, deadline: float) -> bool:
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.4):
                return True
        except OSError:
            time.sleep(0.05)
    return False


def _http_via_proxy(port: int, target: str, timeout: float) -> bool:
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": f"http://127.0.0.1:{port}"})
    )
    try:
        with opener.open(target, timeout=timeout) as resp:
            return resp.status in (200, 204)
    except Exception:                                     # noqa: BLE001
        return False


def check_one(rec: dict, binary: str, timeout: float = 8.0) -> tuple[bool, float | None]:
    """Run one config through Xray and report whether HTTP traffic passed."""
    if rec["proto"] not in SUPPORTED_PROTOCOLS:
        return False, None
    if (rec["network"] or "tcp") not in ACCEPT_NETWORKS:
        return False, None

    port = _free_port()
    cfg_dir = tempfile.mkdtemp(prefix="xray-")
    cfg_path = os.path.join(cfg_dir, "config.json")
    try:
        with open(cfg_path, "w", encoding="utf-8") as fh:
            json.dump(build_config(rec, port), fh)
    except Exception:                                     # noqa: BLE001
        shutil.rmtree(cfg_dir, ignore_errors=True)
        return False, None

    proc = None
    started = time.perf_counter()
    try:
        proc = subprocess.Popen(
            [binary, "run", "-c", cfg_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            env={**os.environ, "XRAY_LOCATION_ASSET": cfg_dir},
        )
        if not _wait_port(port, time.time() + 1.5):
            return False, None
        if _http_via_proxy(port, PROBE_TARGET, timeout):
            return True, round((time.perf_counter() - started) * 1000, 1)
        return False, None
    except Exception:                                     # noqa: BLE001
        return False, None
    finally:
        if proc is not None:
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:                             # noqa: BLE001
                try:
                    proc.kill()
                except Exception:                         # noqa: BLE001
                    pass
        shutil.rmtree(cfg_dir, ignore_errors=True)


def run_deep_check(records: list[dict], workers: int = 8, timeout: float = 8.0,
                   limit: int | None = None) -> dict:
    """Populate rec['deep_ok'] / rec['deep_latency_ms'] for testable records."""
    try:
        binary = ensure_xray()
    except XrayUnavailable as exc:
        return {"available": False, "reason": str(exc), "checked": 0, "passed": 0}

    # A thread pool, not asyncio: every check owns a subprocess and blocks on it.
    from concurrent.futures import ThreadPoolExecutor

    candidates = [r for r in records if r["proto"] in SUPPORTED_PROTOCOLS]
    if limit:
        candidates = candidates[:limit]
    skipped = [r for r in records if r not in candidates]
    for rec in skipped:
        rec["deep_ok"] = None
        rec["deep_latency_ms"] = None

    passed = 0
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {pool.submit(check_one, rec, binary, timeout): rec for rec in candidates}
        for future in futures:
            rec = futures[future]
            try:
                ok, latency = future.result()
            except Exception:                             # noqa: BLE001
                ok, latency = False, None
            rec["deep_ok"] = ok
            rec["deep_latency_ms"] = latency
            passed += int(ok)
    elapsed = round(time.perf_counter() - started, 1)
    return {"available": True, "checked": len(candidates), "passed": passed,
            "seconds": elapsed, "version": XRAY_VERSION}
