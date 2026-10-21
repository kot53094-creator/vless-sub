"""Тесты профиля маршрутизации и заголовков подписки."""

from __future__ import annotations

import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from hub.models import Base, RouteRule, Source
from hub.services import routing, subscription


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()


def test_seed_defaults_is_idempotent(db):
    created = routing.seed_defaults(db)
    assert created == len(routing.DEFAULT_RULES)
    assert routing.seed_defaults(db) == 0
    assert db.query(RouteRule).count() == created


def test_ru_goes_direct_and_ai_goes_abroad(db):
    routing.seed_defaults(db)
    rules = routing.build_route(db)

    direct = [r for r in rules if r.get("outbound") == "direct"]
    assert any("category-ru" in r.get("geosite", []) for r in direct)
    assert any("ru" in r.get("geoip", []) for r in direct)

    usa = [r for r in rules if r.get("outbound") == "usa"]
    usa_domains = {d for rule in usa for d in rule.get("domain_suffix", [])}
    assert "openai.com" in usa_domains
    assert "claude.ai" in usa_domains

    nearest = [r for r in rules if r.get("outbound") == "nearest-udp"]
    assert any(r.get("network") == ["udp"] for r in nearest)


def test_direct_rule_wins_by_order(db):
    """Правило «RU напрямую» должно стоять раньше остальных."""
    routing.seed_defaults(db)
    rules = routing.build_route(db)
    assert rules[0]["outbound"] == "direct"


def test_disabled_rule_is_excluded(db):
    db.add(RouteRule(name="ИИ", match_type="domain", value="openai.com",
                     outbound="usa", sort=10))
    db.add(RouteRule(name="Выкл", match_type="domain", value="example.com",
                     outbound="eu", enabled=False, sort=20))
    db.commit()

    route = routing.build_route(db)
    values = {d for rule in route for d in rule.get("domain_suffix", [])}
    assert "openai.com" in values
    assert "example.com" not in values


def test_same_outbound_is_merged_into_one_rule(db):
    for index, domain in enumerate(["a.com", "b.com", "c.com"]):
        db.add(RouteRule(name=domain, match_type="domain", value=domain,
                         outbound="usa", sort=index))
    db.commit()

    route = routing.build_route(db)
    usa = [r for r in route if r.get("outbound") == "usa"]
    assert len(usa) == 1
    assert usa[0]["domain_suffix"] == ["a.com", "b.com", "c.com"]


def test_profile_shape_and_final_outbound(db):
    routing.seed_defaults(db)
    profile = routing.build_profile(db, subscription.MODE_WHITELIST)

    assert profile["profile"] == "VPN Hub"
    assert profile["mode"] == "whitelist"
    assert profile["route"]["final"] == "main"
    assert isinstance(profile["route"]["rules"], list)
    assert profile["tags"]["direct"] == "напрямую"
    assert profile["tags"]["nearest-udp"] == "ближайшая нода (UDP)"
    assert "T" in profile["generated_at"]  # ISO-8601


def test_profile_json_is_valid_json(db):
    routing.seed_defaults(db)
    parsed = json.loads(routing.profile_json(db, indent=None))
    assert parsed["route"]["rules"]
    assert parsed["route"]["final"] == "main"


def test_split_values_and_normalizers():
    assert routing.split_values("a.com, b.com; c.com\nd.com , a.com") == \
        ["a.com", "b.com", "c.com", "d.com"]
    assert routing.split_values("  ") == []
    assert routing.normalize_outbound("в космос") == "main"
    assert routing.normalize_outbound("direct") == "direct"
    assert routing.normalize_match_type("whatever") == "domain"
    assert routing.normalize_match_type("geoip") == "geoip"


def test_summary_counts_by_outbound(db):
    routing.seed_defaults(db)
    counters = routing.summary(routing.build_route(db))
    assert sum(counters.values()) == len(routing.build_route(db))
    assert counters.get("direct", 0) >= 1


def test_userinfo_header_aggregates_active_sources(db):
    db.add(Source(name="a", kind="trial", url="vless://a", used_bytes=40, total_bytes=100))
    db.add(Source(name="b", kind="trial", url="vless://b", used_bytes=60, total_bytes=100))
    db.add(Source(name="off", kind="trial", url="vless://c", status="disabled",
                  used_bytes=999, total_bytes=999))
    db.commit()

    header = subscription.userinfo_header(db)
    parts = dict(item.strip().split("=") for item in header.split(";"))
    assert parts["download"] == "100"      # отключённый источник не считается
    assert parts["total"] == "200"
    assert parts["upload"] == "0"
