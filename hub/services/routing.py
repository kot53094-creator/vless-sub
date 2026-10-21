"""Маршрутизация для Happ: правила и экспорт профиля.

Хаб отдаёт правила в формате sing-box route (его понимают Happ, sing-box,
nekobox и прочие клиенты на этом ядре). Теги выходов логические:

  direct      — напрямую, без VPN (российские сайты)
  main        — основной профиль (первый живой узел подписки)
  usa / eu    — выход через узел США / ЕС (для ИИ-сервисов)
  nearest-udp — ближайшая по пингу нода по UDP (Hysteria2) — для игр

Клиент не умеет подставлять «свой» тег автоматически, поэтому в Happ теги
сопоставляются один раз на экране Routing. Инструкция — на странице
«Маршрутизация».
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import RouteRule

# match_type → ключ правила sing-box
RULE_KEYS = {
    "domain": "domain_suffix",
    "geosite": "geosite",
    "geoip": "geoip",
    "ip": "ip_cidr",
    "network": "network",
}

OUTBOUNDS = {
    "direct": "direct",
    "main": "main",
    "usa": "usa",
    "eu": "eu",
    "nearest": "nearest-udp",
}

OUTBOUND_LABELS = {
    "direct": "напрямую",
    "main": "основной профиль",
    "usa": "выход США",
    "eu": "выход ЕС",
    "nearest": "ближайшая нода (UDP)",
}

# Правила по умолчанию. Порядок важен: сначала «напрямую», потом исключения.
DEFAULT_RULES: tuple[tuple[str, str, str, str, int, str], ...] = (
    ("Российские домены — напрямую", "geosite", "category-ru", "direct", 10,
     "банки, госуслуги, маркетплейсы не идут через VPN"),
    ("Российские адреса — напрямую", "geoip", "ru", "direct", 11, ""),
    ("ИИ: OpenAI и ChatGPT", "domain", "openai.com, chatgpt.com, sora.com", "usa", 20,
     "через США: часть сервисов не работает из ЕС"),
    ("ИИ: Anthropic и Claude", "domain", "anthropic.com, claude.ai", "usa", 21, ""),
    ("ИИ: Google Gemini", "domain", "gemini.google.com, aistudio.google.com, generativelanguage.googleapis.com",
     "usa", 22, ""),
    ("ИИ: Perplexity и Copilot", "domain", "perplexity.ai, copilot.microsoft.com", "eu", 23, ""),
    ("Игры по UDP — ближайшая нода", "network", "udp", "nearest", 40,
     "низкий пинг важнее страны выхода"),
)

DEFAULT_FOOTER = "main"


def seed_defaults(db: Session) -> int:
    """Заполняет таблицу правилами по умолчанию. Идемпотентно."""
    if db.execute(select(RouteRule.id).limit(1)).first():
        return 0
    for name, match_type, value, outbound, sort, note in DEFAULT_RULES:
        db.add(RouteRule(name=name, match_type=match_type, value=value,
                         outbound=outbound, sort=sort, note=note))
    db.commit()
    return len(DEFAULT_RULES)


def normalize_outbound(value: str) -> str:
    return value if value in OUTBOUNDS else "main"


def normalize_match_type(value: str) -> str:
    return value if value in RULE_KEYS else "domain"


def split_values(value: str) -> list[str]:
    """«a.com, b.com  c.com» → список без пустых и лишних пробелов."""
    out: list[str] = []
    for chunk in value.replace("\n", ",").replace(";", ",").split(","):
        item = chunk.strip()
        if item and item not in out:
            out.append(item)
    return out


def ordered_rules(db: Session, only_enabled: bool = False) -> list[RouteRule]:
    stmt = select(RouteRule).order_by(RouteRule.sort, RouteRule.id)
    if only_enabled:
        stmt = stmt.where(RouteRule.enabled.is_(True))
    return list(db.execute(stmt).scalars().all())


def build_route(db: Session, mode: str = "normal") -> list[dict]:
    """Правила sing-box: одинаковые (тип, выход) склеиваются в одно правило."""
    grouped: dict[tuple[str, str], list[str]] = {}
    for rule in ordered_rules(db, only_enabled=True):
        key_name = RULE_KEYS.get(rule.match_type, "domain_suffix")
        outbound = OUTBOUNDS.get(rule.outbound, "main")
        bucket = grouped.setdefault((key_name, outbound), [])
        for item in split_values(rule.value):
            if item not in bucket:
                bucket.append(item)

    result: list[dict] = []
    for (key_name, outbound), values in grouped.items():
        result.append({key_name: values, "outbound": outbound})
    return result


def build_profile(db: Session, mode: str = "normal") -> dict:
    """Готовый JSON: route.rules + расшифровка тегов."""
    return {
        "profile": "VPN Hub",
        "format": "sing-box route rules",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "mode": mode,
        "route": {
            "rules": build_route(db, mode),
            "final": DEFAULT_FOOTER,
            "auto_detect_interface": True,
        },
        "tags": {tag: OUTBOUND_LABELS.get(src, src) for src, tag in OUTBOUNDS.items()},
    }


def profile_json(db: Session, mode: str = "normal", indent: int | None = 2) -> str:
    return json.dumps(build_profile(db, mode), ensure_ascii=False, indent=indent)


def summary(route: list[dict]) -> dict:
    """Короткая сводка для главной страницы и логов."""
    counters: dict[str, int] = {}
    for item in route:
        out = str(item.get("outbound", "main"))
        counters[out] = counters.get(out, 0) + 1
    return counters
