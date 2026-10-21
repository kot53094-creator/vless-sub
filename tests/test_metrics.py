"""Тесты метрик, дедлайнов, нагрузки и второго фактора."""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from hub import security
from hub.models import Base, CheckEvent, NotificationSent, Server, Source, TrafficSample, utcnow
from hub.services import deadlines, health, traffic
from hub.services.provision import parse_load


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()


def test_traffic_day_usage_counts_only_delta(db):
    src = Source(name="a", kind="trial", url="vless://a", used_bytes=1000)
    db.add(src)
    db.commit()

    traffic.record(db)                      # базовый снимок: 1000
    src.used_bytes = 1500                   # +500 за сутки
    db.commit()

    assert traffic.day_usage(db) == 500
    assert traffic.month_usage(db) == 500


def test_traffic_ignores_negative_delta(db):
    src = Source(name="a", kind="trial", url="vless://a", used_bytes=5000)
    db.add(src)
    db.commit()
    traffic.record(db)

    src.used_bytes = 100                    # счётчик сбросили в панели
    db.commit()
    assert traffic.day_usage(db) == 0


def test_traffic_skips_sources_without_samples(db):
    db.add(Source(name="b", kind="trial", url="vless://b", used_bytes=999))
    db.commit()
    assert traffic.day_usage(db) == 0


def test_health_seven_days_and_availability(db):
    src = Source(name="a", kind="trial", url="vless://a")
    db.add(src)
    db.commit()

    health.record(db, src.id, True, 40)
    health.record(db, src.id, True, 50)
    health.record(db, src.id, False, None, "таймаут")
    db.commit()

    series = health.seven_days(db)[src.id]
    assert len(series) == 7
    today = series[-1]
    assert today["pct"] == 67
    assert today["ok"] is True
    assert health.availability(db, src.id) == 67


def test_health_empty_history_is_none(db):
    src = Source(name="a", kind="trial", url="vless://a")
    db.add(src)
    db.commit()
    assert health.availability(db, src.id) is None
    assert src.id not in health.seven_days(db)


def test_notification_dedupe_per_day(db):
    bucket = utcnow().date().isoformat()
    assert not deadlines._already(db, "source_expiry", "source:1", bucket)

    deadlines._mark(db, "source_expiry", "source:1", bucket)
    db.commit()

    assert deadlines._already(db, "source_expiry", "source:1", bucket)
    assert not deadlines._already(db, "source_expiry", "source:2", bucket)
    assert not deadlines._already(db, "source_expiry", "source:1", "1999-01-01")


def test_days_left_for_source_and_server(db):
    src = Source(name="a", kind="trial", url="vless://a",
                 expires_at=utcnow() + timedelta(days=3))
    srv = Server(name="vps", ip="1.2.3.4", rent_until=utcnow() + timedelta(days=3))
    assert src.days_left == 3
    assert srv.days_left == 3


def test_source_traffic_percent(db):
    src = Source(name="a", kind="trial", url="vless://a", used_bytes=95, total_bytes=100)
    assert src.traffic_pct == 95.0
    src.used_bytes = 120
    assert src.traffic_pct == 100.0


def test_parse_load_reads_cpu_and_ram():
    pct, info = parse_load("4\n0.75 0.50 0.30 1/100 1234\n512 2048\n")
    assert pct == 25
    assert "CPU 19%" in info and "RAM 512/2048" in info


def test_parse_load_empty_text_is_safe():
    pct, info = parse_load("")
    assert pct == 0
    assert "CPU" in info


def test_totp_is_off_without_secret():
    assert security.totp_required() is False
    assert security.verify_totp("") is True


def test_totp_checks_real_code(monkeypatch):
    import pyotp

    secret = pyotp.random_base32()
    monkeypatch.setattr(security.settings, "totp_secret", secret)

    code = pyotp.TOTP(secret).now()
    assert security.totp_required() is True
    assert security.verify_totp(code) is True
    assert security.verify_totp("000000") is False
    assert security.verify_totp("не код") is False
