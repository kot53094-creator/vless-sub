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
  sub-all.txt       base64, everything that passed the validator (unverified included)
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
from urllib.parse import parse_qs, unquote, urlsplit

UA = "v2rayNG/1.9.16"
MAX_SOURCE_BYTES = 16 * 1024 * 1024
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

def fetch_text(url: str, timeout: float = 30.0, retries: int = 2) -> str:
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": UA, "Accept": "*/*", "Accept-Encoding": "identity"},
            )
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
        for ob in cfg.get("outbounds") or []:
            if not isinstance(ob, dict):
                continue
            proto = str(ob.get("protocol", "")).lower()
            if proto not in {"vless", "trojan"}:
                continue
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


def validate_uri(uri: str, allowed: set[str]) -> dict | None:
    """Return a normalised record, or None when the scheme is not wanted."""
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
    if is_private_host(host):
        raise Bad("private/loopback host")

    userinfo = unquote(parts.username or "")
    params = _query(parts)
    record: dict = {
        "uri": uri,
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
    }

    if scheme == "vless":
        if not UUID_RE.match(userinfo):
            raise Bad("vless id is not a UUID")
        if params.get("encryption", "none").lower() not in {"", "none"}:
            raise Bad("vless encryption must be none")
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
        record["alpn"], userinfo.lower(),
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


def     render_index(total: int, all_total: int, built: str, sources: list[dict], degraded: bool) -> str:
    rows = "\n".join(
        f"<tr><td>{'ok' if s['ok'] else 'fail'}</td>"
        f"<td>{(s['name'] if s['ok'] else (s['name'] + ' — ' + str(s.get('error',''))[:80]))}</td>"
        f"<td>{s['kept']}</td><td>{s['seen']}</td></tr>"
        for s in sources
    )
    note = ("<p style='color:#b00'><b>Внимание:</b> проверка доступности не дала результата "
            "(возможно, сеть сборщика ограничена). Опубликован непроверенный список.</p>"
            if degraded else "")
    return f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VLESS subscription</title>
<style>
body{{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#111}}
code{{background:#f2f2f2;padding:2px 6px;border-radius:4px;word-break:break-all}}
table{{border-collapse:collapse;width:100%;margin-top:16px;font-size:14px}}
td,th{{border-bottom:1px solid #e5e5e5;padding:6px 8px;text-align:left}}
.muted{{color:#666;font-size:14px}}
</style></head><body>
<h1>VLESS subscription</h1>
{note}
<p>Ссылка для v2rayNG:</p>
<p><code>sub.txt</code> — <a href="sub.txt">скачать / вставить в клиент</a></p>
<ul>
<li><b>sub.txt</b> — конфиги, ответившие на проверку TCP/TLS, {total}</li>
<li><b>sub-plain.txt</b> — тот же список текстом</li>
<li><b>sub-all.txt</b> — все валидные конфиги, включая непроверенные, {all_total}</li>
<li><b>status.json</b> — состояние источников</li>
</ul>
<p class="muted">Сборка: {built}. Проверка доступности = TCP/TLS-ответ узла, это не гарантия,
что прокси пропускает трафик. Конфиги принадлежат третьим лицам.</p>
<table><tr><th>источник</th><th>в подписке</th><th>получено</th></tr>{rows}</table>
</body></html>
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
    ap.add_argument("--max-configs", type=int, default=int(os.getenv("MAX_CONFIGS", "800")))
    ap.add_argument("--max-all", type=int, default=int(os.getenv("MAX_ALL", "2000")))
    ap.add_argument("--min-configs", type=int, default=int(os.getenv("MIN_CONFIGS", "20")))
    ap.add_argument("--max-per-host", type=int, default=int(os.getenv("MAX_PER_HOST", "4")))
    ap.add_argument("--allow-protocols", default=os.getenv("ALLOW_PROTOCOLS", "vless"))
    ap.add_argument("--no-probe", action="store_true", help="skip reachability probe")
    ap.add_argument("--force", action="store_true", help="publish even if the result shrank")
    ap.add_argument("--dry-run", action="store_true", help="print stats, write nothing")
    ap.add_argument("--no-publish-commit", action="store_true",
                    help="do not commit docs/ to git even when running in CI")
    return ap.parse_args(argv)


def load_sources(path: str) -> list[dict]:
    items: list[dict] = []
    with open(path, "r", encoding="utf-8-sig") as fh:
        for raw in fh:
            line = raw.strip().lstrip("\ufeff").strip()
            if not line or line.startswith("#"):
                continue
            items.append({"url": line, "name": line.split("://", 1)[-1][:70],
                          "private": False})
    return items


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    allowed = {p.strip().lower() for p in args.allow_protocols.split(",") if p.strip()}
    started_wall = datetime.now(timezone.utc)
    print(f"[build] start {started_wall.isoformat(timespec='seconds')} "
          f"protocols={sorted(allowed)}")

    sources = load_sources(args.sources)
    private_url = (os.getenv("PRIVATE_SUB_URL") or "").strip()
    include_private = (os.getenv("INCLUDE_PRIVATE") or "").strip().lower() in {"1", "true", "yes"}
    if private_url and include_private:
        sources.append({"url": private_url, "name": "private-subscription", "private": True})
        print("[build] private source: enabled (content will be PUBLIC in the result)")
    elif private_url:
        print("[build] private source: present but INCLUDE_PRIVATE is not set -> skipped")

    all_records: list[dict] = []
    status: list[dict] = []
    for src in sources:
        entry = {"name": ("<private>" if src["private"] else src["name"]),
                 "ok": False, "seen": 0, "kept": 0, "error": ""}
        try:
            text = fetch_text(src["url"], timeout=args.timeout)
            lines = decode_payload(text)
            seen = 0
            kept = 0
            reasons: Counter = Counter()
            for line in lines:
                if "://" not in line:
                    continue
                seen += 1
                try:
                    rec = validate_uri(line, allowed)
                except Bad as exc:
                    reasons[str(exc)] += 1
                    continue
                except Exception as exc:                  # noqa: BLE001
                    reasons[type(exc).__name__] += 1
                    continue
                if rec is None:
                    reasons["other protocol"] += 1
                    continue
                rec["origin"] = entry["name"]
                all_records.append(rec)
                kept += 1
            entry.update(ok=True, seen=seen, kept=kept)
            top = ", ".join(f"{k}:{v}" for k, v in reasons.most_common(3))
            print(f"[source] ok kept={kept}/{seen} {entry['name'][:60]}"
                  + (f" (dropped {top})" if top else ""))
        except FetchError as exc:
            entry["error"] = str(exc)[:160]
            print(f"[source] FAIL {entry['name'][:60]} -> {entry['error'][:90]}")
        except Exception as exc:                          # noqa: BLE001
            entry["error"] = f"{type(exc).__name__}: {exc}"[:160]
            print(f"[source] FAIL {entry['name'][:60]} -> {entry['error'][:90]}")
        status.append(entry)

    ok_sources = [s for s in status if s["ok"]]
    if not ok_sources:
        print("[build] ABORT: no source could be read; previous result left untouched")
        return 2

    # ---- deduplicate -------------------------------------------------------
    uniq: dict[str, dict] = {}
    exact: set[str] = set()
    dups = 0
    for rec in all_records:
        if rec["uri"] in exact:
            dups += 1
            continue
        exact.add(rec["uri"])
        if rec["fingerprint"] in uniq:
            dups += 1
            continue
        uniq[rec["fingerprint"]] = rec
    records = list(uniq.values())
    print(f"[dedup] {len(all_records)} -> {len(records)} ({dups} duplicates removed)")

    # ---- per-host cap ------------------------------------------------------
    per_host: Counter = Counter()
    capped: list[dict] = []
    for rec in records:
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

    # ---- ordering ----------------------------------------------------------
    def rank(rec: dict) -> tuple:
        reach = 0 if rec["reachable"] else 1
        lat = rec["latency_ms"] if rec["latency_ms"] is not None else 9e9
        return (reach, lat, rec["host"])

    records.sort(key=rank)
    reachable = [r for r in records if r["reachable"]]
    degraded = False
    if len(reachable) >= args.min_configs:
        selected = reachable[: args.max_configs]
    else:
        # Probe gave nothing usable (network blocked in CI?) -> publish everything,
        # but say so loudly instead of silently shipping an unverified list as "verified".
        degraded = True
        selected = records[: args.max_configs]
    everything = records[: args.max_all]

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

    if degraded and not args.no_probe:
        print("[probe] WARNING: nothing answered the probe; publishing the full list")

    payload = "\n".join(r["uri"] for r in selected) + "\n"
    all_payload = "\n".join(r["uri"] for r in everything) + "\n"

    if args.dry_run:
        mode = "unverified (probe skipped)" if args.no_probe else "probed"
        print(f"[dry-run] would publish {len(selected)} {mode} configs "
              f"({len(payload)} bytes) + full list {len(everything)}")
        return 0

    # ---- write -------------------------------------------------------------
    os.makedirs(args.out, exist_ok=True)
    write_atomic(os.path.join(args.out, "sub.txt"), b64encode_std(payload))
    write_atomic(os.path.join(args.out, "sub-plain.txt"), payload)
    write_atomic(os.path.join(args.out, "sub-all.txt"), b64encode_std(all_payload))
    write_atomic(os.path.join(args.out, ".nojekyll"), "")
    legacy = os.path.join(args.out, "sub-verified.txt")
    if os.path.exists(legacy):          # leftover from an older layout
        os.remove(legacy)

    by_proto = Counter(r["proto"] for r in selected)
    meta = {
        "built_at": started_wall.isoformat(timespec="seconds"),
        "configs": len(selected),
        "reachable_total": len(reachable),
        "configs_all": len(everything),
        "probe_degraded": degraded,
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
                 render_index(len(selected), len(everything),
                              meta["built_at"], status, degraded))
    print(f"[done] published {len(selected)} probed configs + {len(everything)} total, "
          f"{len(payload)} bytes -> {args.out}")

    if os.getenv("GITHUB_ACTIONS") == "true" and not args.no_publish_commit:
        publish_commit(args.out)
    return 0
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
