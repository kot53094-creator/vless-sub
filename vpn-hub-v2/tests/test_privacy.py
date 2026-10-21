"""Платное личное и приватное никогда не попадает в подписку."""

from __future__ import annotations

import base64

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import Base, NodeKey, Source
from app.services.builder import MODE_WHITELIST, build, deliverable_keys, is_deliverable


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()


def add_source(db, name, kind, visibility="shareable", status="alive", port=443):
    source = Source(name=name, kind=kind, url="vless://x", visibility=visibility, status=status)
    db.add(source)
    db.commit()
    db.add(NodeKey(
        source_id=source.id,
        uri=f"vless://11111111-1111-1111-1111-11111111111{port}@{name}.example:{port}?security=tls#{name}",
        proto="vless", host=f"{name}.example", port=port, remark=name,
        fingerprint=f"fp-{name}-{port}", alive=True, latency_ms=50,
    ))
    db.commit()
    return source


def test_paid_private_never_delivered(db):
    add_source(db, "paid", "paid_private")
    add_source(db, "public", "public")

    keys = deliverable_keys(db)
    names = [source.name for source, _ in keys]
    assert names == ["public"]
    assert "paid" not in names


def test_private_visibility_never_delivered(db):
    add_source(db, "mine", "own_vps", visibility="private")
    add_source(db, "mine2", "own_vps")

    names = [source.name for source, _ in deliverable_keys(db)]
    assert names == ["mine2"]


def test_dead_and_unchecked_keys_are_skipped(db):
    source = add_source(db, "dead", "public", status="dead")
    add_source(db, "ok", "trial")
    assert [s.name for s, _ in deliverable_keys(db)] == ["ok"]


def test_order_own_vps_then_trial_then_public(db):
    add_source(db, "pub", "public")
    add_source(db, "trial", "trial")
    add_source(db, "own", "own_vps")

    body, count = build(db)
    decoded = base64.b64decode(body).decode()
    order = [line.split("@")[1].split(":")[0].split(".")[0] for line in decoded.splitlines()]
    assert order == ["own", "trial", "pub"]
    assert count == 3


def test_duplicates_removed(db):
    source = add_source(db, "dup", "public")
    db.add(NodeKey(source_id=source.id, uri="vless://2222@dup.example:8443?security=tls#dup2",
                   proto="vless", host="dup.example", port=8443, fingerprint="other", alive=True))
    db.commit()

    # тот же fingerprint, что у первого ключа — второй раз не попадёт
    db.add(NodeKey(source_id=source.id, uri="vless://3333@dup.example:443?security=tls#dup3",
                   proto="vless", host="dup.example", port=443, fingerprint="fp-dup-443", alive=True))
    db.commit()

    assert len(deliverable_keys(db)) == 2


def test_whitelist_mode_keeps_private_out(db):
    add_source(db, "paid", "paid_private")
    add_source(db, "own", "own_vps")
    names = [s.name for s, _ in deliverable_keys(db, MODE_WHITELIST)]
    assert names == ["own"]


def test_is_deliverable_flags():
    assert is_deliverable(Source(name="p", kind="paid_private", url="x", visibility="shareable")) is False
    assert is_deliverable(Source(name="p", kind="own_vps", url="x", visibility="private")) is False
    assert is_deliverable(Source(name="p", kind="own_vps", url="x", status="dead")) is False
    assert is_deliverable(Source(name="p", kind="own_vps", url="x", visibility="shareable", status="alive")) is True
