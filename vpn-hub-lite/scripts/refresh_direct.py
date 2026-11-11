#!/usr/bin/env python3
"""Освежение прямого резерва подписки (`direct:links`).

Зачем: узлы у оператора живут десятки минут, а подписка собирается из базы,
где проверки шли из другой сети. Скрипт проверяет реальным туннелем текущий
резерв, выбрасывает мёртвое, добирает свежее из публичных списков и кладёт
результат в KV. Кэш подписки сбрасывается через `pool:stamp` — деплой не нужен.

Требуется: sing-box (hysteria/hysteria2/tuic/anytls), xray (vless), wrangler.
Запуск:  python scripts/refresh_direct.py
"""

from __future__ import annotations

import base64
import concurrent.futures as cf
import glob
import json
import os
import random
import re
import shutil
import socket
import subprocess
import sys
import time
from urllib.parse import parse_qs, unquote, urlparse

TEMP = os.environ.get("TEMP") or os.environ.get("TMP") or "/tmp"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KV_NS = "31299bcce7184a7f877d90e86853e5d1"
TARGET = 14
MIN_KEEP = 6
ROUNDS = 2
WORKERS = 8
TIMEOUT = 6
STATE_PATH = os.path.join(TEMP, "refresh-direct-state.json")
BACKUP_PATH = os.path.join(TEMP, "direct-links.backup.txt")
LOG_PATH = os.path.join(TEMP, "refresh-direct.log")

SOURCES = [
    "https://raw.githubusercontent.com/soroushmirzaei/telegram-configs-collector/main/protocols/hysteria2",
    "https://raw.githubusercontent.com/soroushmirzaei/telegram-configs-collector/main/protocols/tuic",
    "https://raw.githubusercontent.com/soroushmirzaei/telegram-configs-collector/main/protocols/anytls",
    "https://raw.githubusercontent.com/yebekhe/TelegramV2rayCollector/main/sub/normal/mix",
    "https://raw.githubusercontent.com/Epodonios/v2ray-configs/main/All_Configs_Sub.txt",
    "https://raw.githubusercontent.com/mfuu/v2ray/master/v2ray",
    "https://raw.githubusercontent.com/peasoft/NoMoreWalls/master/list.txt",
]

SCHEMES = ("vless", "hysteria2", "hy2", "hysteria", "tuic", "anytls", "trojan")
WHITE_SNI = ("bing.com", "shopify.com", "microsoft.com", "apple.com", "icloud.com",
             "samsung.com", "cloudflare.com", "amazon.com", "intel.com")

FLAGS = {
    "RU": "🇷🇺", "DE": "🇩🇪", "NL": "🇳🇱", "FR": "🇫🇷", "SE": "🇸🇪", "FI": "🇫🇮",
    "NO": "🇳🇴", "CH": "🇨🇭", "GB": "🇬🇧", "US": "🇺🇸", "CA": "🇨🇦", "TR": "🇹🇷",
    "SG": "🇸🇬", "HK": "🇭🇰", "JP": "🇯🇵", "KR": "🇰🇷", "IN": "🇮🇳", "AE": "🇦🇪",
    "PL": "🇵🇱", "CZ": "🇨🇿", "AT": "🇦🇹", "IT": "🇮🇹", "ES": "🇪🇸", "RO": "🇷🇴",
    "BG": "🇧🇬", "LT": "🇱🇹", "LV": "🇱🇻", "EE": "🇪🇪", "MD": "🇲🇩", "KZ": "🇰🇿",
    "AM": "🇦🇲", "GE": "🇬🇪", "RS": "🇷🇸", "HU": "🇭🇺", "SK": "🇸🇰", "UA": "🇺🇦",
}
NAMES = {
    "RU": "Россия", "DE": "Германия", "NL": "Нидерланды", "FR": "Франция",
    "SE": "Швеция", "FI": "Финляндия", "NO": "Норвегия", "CH": "Швейцария",
    "GB": "Великобритания", "US": "США", "CA": "Канада", "TR": "Турция",
    "SG": "Сингапур", "HK": "Гонконг", "JP": "Япония", "KR": "Южная Корея",
    "IN": "Индия", "AE": "ОАЭ", "PL": "Польша", "CZ": "Чехия", "AT": "Австрия",
    "IT": "Италия", "ES": "Испания", "RO": "Румыния", "BG": "Болгария",
    "LT": "Литва", "LV": "Латвия", "EE": "Эстония", "MD": "Молдова",
    "KZ": "Казахстан", "AM": "Армения", "GE": "Грузия", "RS": "Сербия",
    "HU": "Венгрия", "SK": "Словакия", "UA": "Украина",
}


def log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def find_tool(env_name: str, patterns: list[str]) -> str | None:
    explicit = os.environ.get(env_name)
    if explicit and os.path.exists(explicit):
        return explicit
    for pattern in patterns:
        hits = sorted(glob.glob(pattern))
        if hits:
            return hits[-1]
    name = patterns[-1].rsplit(os.sep, 1)[-1].split("*")[0]
    found = shutil.which(name)
    return found


SINGBOX = find_tool("SINGBOX", [
    os.path.join(TEMP, "sbin", "sing-box-*", "sing-box.exe"),
    os.path.join(TEMP, "sbin", "sing-box-*", "sing-box"),
])
XRAY = find_tool("XRAY", [
    os.path.join(TEMP, "xray-local", "xray.exe"),
    os.path.join(TEMP, "xray-local", "xray"),
])
WRANGLER = find_tool("WRANGLER", [
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "npm-cache", "_npx", "*", "node_modules", ".bin", "wrangler.cmd"),
    os.path.join(os.environ.get("APPDATA", ""), "npm", "wrangler.cmd"),
]) or "wrangler"


# ---------------------------------------------------------------- утилиты

def norm(link: str) -> str:
    link = link.strip()
    if link.lower().startswith("hy2://"):
        link = "hysteria2://" + link.split("://", 1)[1]
    return link


def endpoint(link: str) -> str:
    try:
        u = urlparse(norm(link))
        host = (u.hostname or "").lower()
        port = u.port or 443
        return f"{host}:{port}"
    except ValueError:
        return ""


def host_of(link: str) -> str:
    try:
        return (urlparse(norm(link)).hostname or "").lower()
    except ValueError:
        return ""


def query(link: str) -> dict[str, str]:
    u = urlparse(norm(link))
    return {k: v[0] for k, v in parse_qs(u.query).items()}


# ---------------------------------------------------------------- проверка

def hy_outbound(link: str) -> dict | None:
    u = urlparse(norm(link))
    q = query(link)
    scheme = u.scheme.lower()
    host, port = u.hostname, u.port or 443
    if not host:
        return None
    tls = {"enabled": True, "server_name": q.get("sni") or q.get("peer") or host,
           "insecure": str(q.get("insecure", "1")).lower() in ("1", "true")}
    if q.get("alpn"):
        tls["alpn"] = [a for a in q["alpn"].split(",") if a]
    auth = unquote(u.username or "")
    if scheme == "hysteria2":
        ob = {"type": "hysteria2", "server": host, "server_port": port, "password": auth, "tls": tls}
        if q.get("obfs"):
            ob["obfs"] = {"type": q["obfs"], "password": q.get("obfs-password", "")}
        return ob
    if scheme == "hysteria":
        ob = {"type": "hysteria", "server": host, "server_port": port,
              "up_mbps": int(q.get("upmbps", 20) or 20),
              "down_mbps": int(q.get("downmbps", 20) or 20),
              "auth_str": auth, "tls": tls}
        if q.get("obfs"):
            ob["obfs"] = q["obfs"]
        return ob
    if scheme == "tuic":
        return {"type": "tuic", "server": host, "server_port": port, "uuid": auth,
                "password": q.get("password", ""), "tls": tls}
    if scheme == "anytls":
        return {"type": "anytls", "server": host, "server_port": port,
                "password": auth, "tls": tls}
    return None


def xray_config(link: str, port: int) -> dict | None:
    u = urlparse(link)
    q = query(link)
    host, srv_port = u.hostname, u.port or 443
    if not host:
        return None
    net = (q.get("type") or "tcp").lower()
    if net == "raw":
        net = "tcp"
    sec = (q.get("security") or "none").lower()
    user = {"id": unquote(u.username or ""), "encryption": "none"}
    if q.get("flow"):
        user["flow"] = q["flow"]
    if u.scheme.lower() == "trojan":
        user = {"password": unquote(u.username or ""), "flow": q.get("flow", "")}
        sec = sec or "tls"
    stream = {"network": net, "security": sec}
    if sec == "reality":
        stream["realitySettings"] = {
            "serverName": q.get("sni") or host,
            "publicKey": q.get("pbk", ""),
            "shortId": q.get("sid", ""),
            "fingerprint": q.get("fp") or "chrome",
        }
    elif sec == "tls":
        tls = {"serverName": q.get("sni") or host, "allowInsecure": True,
               "fingerprint": q.get("fp") or "chrome"}
        if q.get("alpn"):
            tls["alpn"] = [a for a in q["alpn"].split(",") if a]
        stream["tlsSettings"] = tls
    if net in ("ws", "websocket"):
        ws = {"path": q.get("path") or "/"}
        if q.get("host"):
            ws["headers"] = {"Host": q["host"]}
        stream["wsSettings"] = ws
    elif net == "grpc":
        stream["grpcSettings"] = {"serviceName": q.get("serviceName", "")}
    proto = "trojan" if u.scheme.lower() == "trojan" else "vless"
    settings = ({"servers": [{"address": host, "port": srv_port, "password": user["password"]}]}
                if proto == "trojan"
                else {"vnext": [{"address": host, "port": srv_port, "users": [user]}]})
    return {
        "log": {"loglevel": "error"},
        "inbounds": [{"tag": "in", "port": port, "listen": "127.0.0.1",
                      "protocol": "socks", "settings": {"udp": False}}],
        "outbounds": [{"tag": "out", "protocol": proto, "settings": settings,
                       "streamSettings": stream}],
    }


def curl_via(port: int, url: str) -> tuple[str, int | None]:
    p = subprocess.run(
        ["curl.exe" if os.name == "nt" else "curl", "-4", "--ssl-no-revoke", "-s", "-o", os.devnull,
         "--socks5-hostname", f"127.0.0.1:{port}", "-m", str(TIMEOUT),
         "-w", "%{http_code} %{time_total}", url],
        capture_output=True, text=True)
    parts = (p.stdout or "").strip().split()
    if not parts:
        return "000", None
    try:
        return parts[0], int(float(parts[1]) * 1000)
    except (IndexError, ValueError):
        return parts[0], None


def test_link(idx_link: tuple[int, str]) -> dict:
    idx, link = idx_link
    scheme = norm(link).split("://", 1)[0].lower()
    result = {"link": link, "endpoint": endpoint(link), "ok": False,
              "latency": None, "tg": None, "scheme": scheme}
    if scheme == "vless" or scheme == "trojan":
        if not XRAY:
            result["why"] = "no-xray"
            return result
        runner, sport = XRAY, 41000 + idx % 3000
        cfg = xray_config(link, sport)
        args = [runner, "run", "-c", "{cfg}"]
    else:
        ob = hy_outbound(link)
        if not ob:
            result["why"] = "unsupported"
            return result
        if not SINGBOX:
            result["why"] = "no-singbox"
            return result
        sport = 41000 + idx % 3000
        cfg = {"log": {"level": "error"},
               "inbounds": [{"type": "socks", "tag": "in", "listen": "127.0.0.1",
                             "listen_port": sport}],
               "outbounds": [dict(ob, tag="out")]}
        runner = SINGBOX
        args = [runner, "run", "-c", "{cfg}"]
    if cfg is None:
        result["why"] = "config"
        return result
    path = os.path.join(TEMP, f"rd-{idx}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh)
    args = [a.replace("{cfg}", path) for a in args]
    devnull = open(os.devnull, "wb")
    proc = subprocess.Popen(args, stdout=devnull, stderr=devnull)
    time.sleep(1.2)
    try:
        code, lat = curl_via(sport, "https://www.gstatic.com/generate_204")
        if code == "204":
            result["latency"] = lat
            tg, _ = curl_via(sport, "https://api.telegram.org/")
            result["tg"] = tg
            result["ok"] = tg not in ("000", "", None)
    except Exception as exc:  # noqa: BLE001
        result["why"] = str(exc)[:80]
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
        devnull.close()
        try:
            os.remove(path)
        except OSError:
            pass
    return result


def stable(link: str, idx: int) -> dict | None:
    """Несколько прогонов подряд: один удачный ещё не значит рабочий узел."""
    lat = []
    for rnd in range(ROUNDS):
        r = test_link((idx * 10 + rnd, link))
        if not r["ok"]:
            return None
        lat.append(r["latency"] or 0)
        time.sleep(0.3)
    r["latency"] = int(sum(lat) / len(lat))
    return r


# ---------------------------------------------------------------- метки

def geo(host: str) -> tuple[str, str]:
    ips: list[str] = []
    try:
        ips = sorted({x[4][0] for x in socket.getaddrinfo(host, None, socket.AF_INET)})
    except OSError:
        return "", ""
    if not ips:
        return "", ""
    try:
        p = subprocess.run(["curl.exe" if os.name == "nt" else "curl", "-4", "--ssl-no-revoke",
                            "-s", "-m", "12", f"https://ipwho.is/{ips[0]}"],
                           capture_output=True, text=True)
        data = json.loads(p.stdout or "{}")
        return str(data.get("country_code") or "").upper(), str(data.get("city") or "")
    except (json.JSONDecodeError, OSError):
        return "", ""


def is_white(link: str) -> bool:
    q = query(link)
    if q.get("obfs"):
        return True
    sni = (q.get("sni") or q.get("peer") or q.get("host") or "").lower()
    return any(s in sni for s in WHITE_SNI)


def label_for(link: str, lat: int, old: str | None) -> str:
    if old:
        return old
    host = host_of(link)
    cc, city = geo(host)
    flag = FLAGS.get(cc, "🌐")
    name = NAMES.get(cc, city or host)
    scheme = norm(link).split("://", 1)[0].lower()
    proto = {"hysteria2": "Hysteria2", "hysteria": "Hysteria", "tuic": "TUIC",
             "anytls": "AnyTLS", "vless": "VLESS Reality", "trojan": "Trojan"}.get(scheme, scheme)
    parts = [f"{flag} {name}", proto]
    if lat:
        parts.append(f"{lat / 1000:.1f} с")
    if is_white(link):
        parts.append("Белый список")
    return " · ".join(parts)


def old_label(link: str, previous: dict[str, str]) -> str | None:
    frag = link.split("#", 1)[1] if "#" in link else ""
    if frag:
        try:
            return unquote(frag)
        except ValueError:
            pass
    return previous.get(endpoint(link))


# ---------------------------------------------------------------- KV

def kv_get(key: str) -> str | None:
    p = subprocess.run([WRANGLER, "kv", "key", "get", key, f"--namespace-id={KV_NS}", "--remote"],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        log(f"kv get {key} failed: {p.stderr.strip()[:160]}")
        return None
    return p.stdout


def kv_put(key: str, path: str) -> bool:
    p = subprocess.run([WRANGLER, "kv", "key", "put", key, "--path", path,
                        f"--namespace-id={KV_NS}", "--remote"],
                       cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        log(f"kv put {key} failed: {p.stderr.strip()[:160]}")
        return False
    return True


# ---------------------------------------------------------------- кандидаты

def fetch_candidates() -> list[str]:
    found: dict[str, None] = {}
    for url in SOURCES:
        p = subprocess.run(["curl.exe" if os.name == "nt" else "curl", "-4", "--ssl-no-revoke",
                            "-s", "-L", "-m", "40", url],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        text = p.stdout or ""
        if "://" not in text:
            stripped = re.sub(r"\s+", "", text)
            try:
                text = base64.b64decode(stripped + "=" * (-len(stripped) % 4)).decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                pass
        for line in text.splitlines():
            line = line.strip()
            if line.lower().startswith(SCHEMES):
                found.setdefault(line, None)
    log(f"candidates fetched: {len(found)}")
    return list(found)


def load_state() -> dict:
    try:
        with open(STATE_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {"tested": [], "queue": []}


def save_state(state: dict) -> None:
    state["tested"] = state["tested"][-6000:]
    state["queue"] = state["queue"][:3000]
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False)
    except OSError:
        pass


def load_current() -> tuple[list[str], dict[str, str]]:
    raw = kv_get("direct:links") or ""
    lines = [l.strip() for l in raw.splitlines() if l.strip().lower().startswith(SCHEMES)]
    if not lines:
        try:
            with open(BACKUP_PATH, encoding="utf-8") as fh:
                lines = [l.strip() for l in fh if l.strip().lower().startswith(SCHEMES)]
            log(f"kv empty, backup used: {len(lines)}")
        except OSError:
            lines = []
    labels = {}
    for link in lines:
        frag = link.split("#", 1)[1] if "#" in link else ""
        if frag:
            try:
                labels[endpoint(link)] = unquote(frag)
            except ValueError:
                pass
    return lines, labels


# ---------------------------------------------------------------- main

def main() -> int:
    log("=== refresh start ===")
    log(f"singbox={SINGBOX} xray={XRAY}")
    if not SINGBOX and not XRAY:
        log("нет ни sing-box, ни xray — проверять нечем")
        return 2

    state = load_state()
    tested = set(state.get("tested", []))
    current, labels = load_current()
    log(f"current links: {len(current)}")

    kept: list[dict] = []
    if current:
        with cf.ThreadPoolExecutor(max_workers=WORKERS) as pool:
            for r in pool.map(test_link, list(enumerate(current))):
                if r["ok"]:
                    kept.append(r)
                else:
                    log(f"dead {r['endpoint']} {r['scheme']} {r.get('why', '')}")
        log(f"alive after retest: {len(kept)}/{len(current)}")

    if len(kept) < TARGET:
        candidates = [l for l in state.get("queue", []) if endpoint(l)]
        candidates += fetch_candidates()
        seen = {endpoint(l) for l in current} | {r["endpoint"] for r in kept} | tested
        queue: list[str] = []
        for link in candidates:
            ep = endpoint(link)
            if not ep or ep in seen:
                continue
            seen.add(ep)
            queue.append(link)
        random.shuffle(queue)
        log(f"to test: {len(queue)}")
        tested_now: list[str] = []
        with cf.ThreadPoolExecutor(max_workers=WORKERS) as pool:
            futures = {}
            it = iter(queue)
            # держим окно параллельных проверок, чтобы не ждать весь список
            for _ in range(WORKERS * 2):
                link = next(it, None)
                if link is None:
                    break
                futures[pool.submit(stable, link, len(tested_now) + len(futures))] = link
            while futures and len(kept) < TARGET:
                done, _ = cf.wait(futures, return_when=cf.FIRST_COMPLETED)
                for fut in done:
                    link = futures.pop(fut)
                    tested_now.append(link)
                    r = fut.result()
                    if r:
                        kept.append(r)
                        log(f"NEW {endpoint(link)} {r['scheme']} {r['latency']} ms tg={r['tg']}")
                    nxt = next(it, None)
                    if nxt is not None and len(kept) + len(futures) < TARGET + WORKERS:
                        futures[pool.submit(stable, nxt, len(tested_now) + len(futures))] = nxt
        state["tested"] = list(tested | {endpoint(l) for l in tested_now})
        state["queue"] = [l for l in queue if endpoint(l) not in {endpoint(x) for x in tested_now}]
        save_state(state)

    if len(kept) < MIN_KEEP:
        log(f"слишком мало живых ({len(kept)} < {MIN_KEEP}) — KV не трогаем")
        return 1

    kept.sort(key=lambda r: r["latency"] or 10**6)
    out: list[str] = []
    used_labels: dict[str, int] = {}
    for r in kept:
        label = label_for(r["link"], r["latency"] or 0, old_label(r["link"], labels))
        count = used_labels.get(label, 0) + 1
        used_labels[label] = count
        if count > 1:
            label = f"{label} #{count}"
        base = norm(r["link"]).split("#", 1)[0]
        out.append(f"{base}#{quote_plus(label)}")

    payload = "\n".join(out) + "\n"
    path = os.path.join(TEMP, "direct-refresh.txt")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(payload)
    with open(BACKUP_PATH, "w", encoding="utf-8") as fh:
        fh.write(payload)

    snapshot = base64.b64encode(payload.encode("utf-8")).decode("ascii")
    snap_path = os.path.join(TEMP, "snapshot-refresh.b64")
    with open(snap_path, "w", encoding="ascii") as fh:
        fh.write(snapshot)

    ok = kv_put("direct:links", path)
    ok = kv_put("snapshot:default", snap_path) and ok
    ok = kv_put("snapshot:free", snap_path) and ok
    stamp_path = os.path.join(TEMP, "pool-stamp.txt")
    with open(stamp_path, "w", encoding="ascii") as fh:
        fh.write(str(int(time.time())))
    ok = kv_put("pool:stamp", stamp_path) and ok
    log(f"written {len(out)} links, ok={ok}")
    for line in out:
        log("  " + unquote(line.split("#", 1)[1]) + "  " + endpoint(line))
    log("=== refresh done ===")
    return 0 if ok else 3


def quote_plus(text: str) -> str:
    from urllib.parse import quote
    return quote(text, safe="")


if __name__ == "__main__":
    sys.exit(main())
