"""Схема БД: источники, ключи, настройки, люди (модуль B), журнал."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


KINDS = ("own_vps", "trial", "public", "paid_private")
KIND_LABELS = {
    "own_vps": "Мой VPS",
    "trial": "Триал",
    "public": "Публичная",
    "paid_private": "Платный личный",
}
# Порядок выдачи: мои VPS → триалы → публичные. Приватные не выдаются никогда.
ORDER_NORMAL = ("own_vps", "trial", "public")
ORDER_WHITELIST = ("bridge", "cdn", "own_vps", "trial", "public")


class Base(DeclarativeBase):
    pass


class Source(Base):
    __tablename__ = "sources"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    kind: Mapped[str] = mapped_column(String(20), default="trial", index=True)
    url: Mapped[str] = mapped_column(Text)

    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    days_manual: Mapped[int | None] = mapped_column(Integer, nullable=True)

    traffic_total: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    traffic_used: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    status: Mapped[str] = mapped_column(String(16), default="unknown", index=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    visibility: Mapped[str] = mapped_column(String(20), default="shareable")
    hwid: Mapped[str] = mapped_column(String(64), default="")
    last_check_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_fetch_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str] = mapped_column(Text, default="")

    keys: Mapped[list["NodeKey"]] = relationship(
        back_populates="source", cascade="all, delete-orphan", lazy="selectin"
    )

    @property
    def is_private(self) -> bool:
        return self.kind == "paid_private" or self.visibility == "private"

    @property
    def deadline(self) -> datetime | None:
        if self.expires_at:
            return as_utc(self.expires_at)
        if self.days_manual:
            return as_utc(self.added_at) + timedelta(days=self.days_manual)
        return None

    @property
    def days_left(self) -> int | None:
        deadline = self.deadline
        if not deadline:
            return None
        return math.ceil((deadline - utcnow()).total_seconds() / 86400)

    @property
    def traffic_pct(self) -> float | None:
        if not self.traffic_total:
            return None
        return min(100.0, 100.0 * (self.traffic_used or 0) / self.traffic_total)


class NodeKey(Base):
    __tablename__ = "node_keys"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"), index=True)
    uri: Mapped[str] = mapped_column(Text)
    proto: Mapped[str] = mapped_column(String(16))
    host: Mapped[str] = mapped_column(String(200))
    port: Mapped[int] = mapped_column(Integer)
    remark: Mapped[str] = mapped_column(String(200), default="")
    security: Mapped[str] = mapped_column(String(16), default="")
    fingerprint: Mapped[str] = mapped_column(String(64), index=True)
    alive: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_check_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str] = mapped_column(Text, default="")

    source: Mapped[Source] = relationship(back_populates="keys", lazy="joined")


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")


class Event(Base):
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    level: Mapped[str] = mapped_column(String(10), default="info")
    kind: Mapped[str] = mapped_column(String(30), default="system")
    message: Mapped[str] = mapped_column(Text)


class AuditLog(Base):
    """Кто и что менял: значение до и после."""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    actor: Mapped[str] = mapped_column(String(60), default="admin")
    action: Mapped[str] = mapped_column(String(60))
    target: Mapped[str] = mapped_column(String(80), default="")
    before: Mapped[str] = mapped_column(Text, default="")
    after: Mapped[str] = mapped_column(Text, default="")


class Probe(Base):
    __tablename__ = "probes"

    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    ru_ok: Mapped[bool] = mapped_column(Boolean, default=False)
    foreign_ok: Mapped[bool] = mapped_column(Boolean, default=False)
    mode: Mapped[str] = mapped_column(String(16), default="normal")


class Person(Base):
    """Пользователь модуля B. Заполняется, только если подключена Remnawave."""

    __tablename__ = "people"

    id: Mapped[int] = mapped_column(primary_key=True)
    tg_id: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    username: Mapped[str] = mapped_column(String(64), default="")
    status: Mapped[str] = mapped_column(String(16), default="trial", index=True)  # trial/active/expired/banned
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    traffic_limit: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    traffic_used: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    device_limit: Mapped[int] = mapped_column(Integer, default=2)
    squad: Mapped[str] = mapped_column(String(80), default="")
    remnawave_uuid: Mapped[str] = mapped_column(String(64), default="")
    trial_used: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    @property
    def days_left(self) -> int | None:
        if not self.expires_at:
            return None
        return math.ceil((as_utc(self.expires_at) - utcnow()).total_seconds() / 86400)


class Tariff(Base):
    __tablename__ = "tariffs"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    days: Mapped[int] = mapped_column(Integer, default=30)
    gb: Mapped[int] = mapped_column(Integer, default=100)
    devices: Mapped[int] = mapped_column(Integer, default=3)
    squad: Mapped[str] = mapped_column(String(80), default="")


class Broadcast(Base):
    __tablename__ = "broadcasts"

    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    text: Mapped[str] = mapped_column(Text)
    sent: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), default="draft")
