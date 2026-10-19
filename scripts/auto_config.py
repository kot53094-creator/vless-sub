"""Сборка «АВТО»-профиля: один конфиг Xray с балансировщиком.

Подписка из vless://-ссылок не умеет выбирать сервер: клиент видит плоский
список и подключается к тому, что нажали. Настоящий «АВТО» — это JSON-конфиг,
внутри которого лежит несколько выходов и балансировщик leastPing: клиент
сам измеряет задержку и уводит трафик на живой быстрый сервер.

Такой файл импортируют Happ и v2RayTun. v2rayNG балансировщики не умеет —
ему достаётся обычный список, где лучший узел стоит первым.
"""

from __future__ import annotations

VERSION = 1

BALANCER_SELECTOR = "auto-"
PROBE_URL = "https://www.connectivitycheck.gstatic.com/generate_204"


def build_outbound(rec: dict) -> dict:
    """Один выход Xray из разобранной ссылки (те же поля, что в xray_check)."""
    from xray_check import _tcp_settings

    proto = rec["proto"]
    if proto == "vless":
        user = {"id": rec["auth"], "encryption": rec.get("encryption") or "none"}
        if rec.get("flow"):
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
    else:
        raise ValueError(f"auto profile does not support {proto}")
    out["streamSettings"] = _tcp_settings(rec)
    return out


def build_auto_config(records: list[dict], limit: int = 12,
                      http_port: int = 10809, socks_port: int = 10808) -> dict:
    """Готовый конфиг: список живых узлов + балансировщик leastPing."""
    outbounds: list[dict] = []
    for index, rec in enumerate(records[:limit], 1):
        out = build_outbound(rec)
        out["tag"] = f"{BALANCER_SELECTOR}{index}"
        outbounds.append(out)
    if len(outbounds) < 2:
        raise ValueError("auto profile needs at least two nodes")

    outbounds.append({"tag": "direct", "protocol": "freedom"})
    outbounds.append({"tag": "block", "protocol": "blackhole"})

    return {
        "remarks": "Апельсинка · АВТО",
        "log": {"loglevel": "warning"},
        "inbounds": [
            {"tag": "socks", "listen": "127.0.0.1", "port": socks_port,
             "protocol": "socks", "settings": {"auth": "noauth", "udp": True}},
            {"tag": "http", "listen": "127.0.0.1", "port": http_port,
             "protocol": "http", "settings": {"allowTransparent": False}},
        ],
        "outbounds": outbounds,
        "routing": {
            "domainStrategy": "AsIs",
            "balancers": [{
                "tag": "auto",
                "selector": [BALANCER_SELECTOR],
                "strategy": {"type": "leastPing"},
            }],
            "rules": [
                {"type": "field", "network": "tcp,udp", "balancerTag": "auto"},
            ],
        },
        "observatory": {
            "subjectSelector": [BALANCER_SELECTOR],
            "probeUrl": PROBE_URL,
            "probeInterval": "30s",
            "enableConcurrency": True,
        },
    }
