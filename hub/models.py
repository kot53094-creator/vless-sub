"""Схема БД: источники, узлы, серверы, прогоны синхронизации, события."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


# Типы источников из ТЗ + значение для ручного одиночного ключа.
SOURCE_KINDS = ("own_vps", "trial", "public", "bridge_ru", "cdn_xhttp")


class Source(Base):
    __tablename__ = "sources"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(20), default="trial", index=True)
    url: Mapped[str] = mapped_column(Text)          # подписка или одиночный vless://
    note: Mapped[str] = mapped_column(String(300), default="")
    priority: Mapped[int] = mapped_column(Integer, default=100)

    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    trial_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    traffic_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)  # байты

    used_bytes: Mapped[int] = mapped_column(Integer, default=0)
    total_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    expire_at_panel: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    status: Mapped[str] = mapped_column(String(20), default="active", index=True)  # active|dead|disabled
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str] = mapped_column(String(300), default="")
    last_report: Mapped[str] = mapped_column(String(300), default="")

    nodes: Mapped[list["Node"]] = relationship(back_populates="source", cascade="all, delete-orphan")

    @property
    def remaining_bytes(self) -> int | None:
        total = self.total_bytes if self.total_bytes is not None else self.traffic_limit
        if total is None:
            return None
        return max(0, total - self.used_bytes)

    @property
    def deadline(self) -> datetime | None:
        """Когда источник перестанет работать: дата панели или ручной расчёт."""
        if self.expire_at_panel:
            return self.expire_at_panel
        if self.expires_at:
            return self.expires_at
        if self.trial_days:
            return self.added_at + timedelta(days=self.trial_days)
        return None

    @property
    def days_left(self) -> int | None:
        deadline = self.deadline
        if not deadline:
            return None
        if deadline.tzinfo is None:
            deadline = deadline.replace(tzinfo=timezone.utc)
        # ceil: «осталось 3 дня» не должно показываться как 2 сразу после выдачи
        return math.ceil((deadline - utcnow()).total_seconds() / 86400)

    @property
    def traffic_pct(self) -> float | None:
        total = self.total_bytes or self.traffic_limit
        if not total:
            return None
        return min(100.0, 100.0 * (self.used_bytes or 0) / total)


class Node(Base):
    __tablename__ = "nodes"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"), index=True)
    uri: Mapped[str] = mapped_column(Text)
    fingerprint: Mapped[str] = mapped_column(String(40), index=True)
    proto: Mapped[str] = mapped_column(String(12), default="vless")
    host: Mapped[str] = mapped_column(String(200), default="")
    port: Mapped[int] = mapped_column(Integer, default=443)
    remark: Mapped[str] = mapped_column(String(200), default="")

    alive: Mapped[bool] = mapped_column(Boolean, default=False)
    tcp_ok: Mapped[bool] = mapped_column(Boolean, default=False)
    tls_ok: Mapped[bool] = mapped_column(Boolean, default=False)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    source: Mapped[Source] = relationship(back_populates="nodes")


class Server(Base):
    __tablename__ = "servers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    provider: Mapped[str] = mapped_column(String(120), default="")
    country: Mapped[str] = mapped_column(String(60), default="")
    ip: Mapped[str] = mapped_column(String(64), default="")
    role: Mapped[str] = mapped_column(String(20), default="direct")  # direct|bridge|cdn
    price: Mapped[float] = mapped_column(Float, default=0.0)
    rent_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ssh_user: Mapped[str] = mapped_column(String(40), default="root")
    ssh_port: Mapped[int] = mapped_column(Integer, default=22)
    ssh_secret_enc: Mapped[str] = mapped_column(Text, default="")  # зашифровано HUB_SECRET_KEY
    links: Mapped[str] = mapped_column(Text, default="")           # vless:// и hysteria2://
    log: Mapped[str] = mapped_column(Text, default="")
    os_info: Mapped[str] = mapped_column(String(120), default="")
    provisioned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="active")
    panel_url: Mapped[str] = mapped_column(String(400), default="")        # панель провайдера
    load_pct: Mapped[int | None] = mapped_column(Integer, nullable=True)   # нагрузка, %
    source_id: Mapped[int | None] = mapped_column(ForeignKey("sources.id"), nullable=True)

    @property
    def days_left(self) -> int | None:
        if not self.rent_until:
            return None
        until = self.rent_until
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        return math.ceil((until - utcnow()).total_seconds() / 86400)


class SyncRun(Base):
    __tablename__ = "sync_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    sources_total: Mapped[int] = mapped_column(Integer, default=0)
    nodes_alive: Mapped[int] = mapped_column(Integer, default=0)
    nodes_dead: Mapped[int] = mapped_column(Integer, default=0)
    published: Mapped[int] = mapped_column(Integer, default=0)
    log: Mapped[str] = mapped_column(Text, default="")
    ok: Mapped[bool] = mapped_column(Boolean, default=True)


class Event(Base):
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    level: Mapped[str] = mapped_column(String(10), default="info")  # info|warn|error
    message: Mapped[str] = mapped_column(String(400))


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")


class RouteRule(Base):
    """Правило маршрутизации для Happ (формат sing-box route)."""

    __tablename__ = "route_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    # domain | geosite | geoip | ip | network
    match_type: Mapped[str] = mapped_column(String(20), default="domain")
    value: Mapped[str] = mapped_column(Text, default="")
    # direct | main | usa | eu | nearest
    outbound: Mapped[str] = mapped_column(String(20), default="main")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    sort: Mapped[int] = mapped_column(Integer, default=100)
    note: Mapped[str] = mapped_column(String(300), default="")

class CheckEvent(Base):
    """История проверок источника — график доступности за 7 дней."""

    __tablename__ = "check_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"),
                                           index=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    ok: Mapped[bool] = mapped_column(Boolean, default=False)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error: Mapped[str] = mapped_column(String(300), default="")


class TrafficSample(Base):
    """Снимок использованного трафика: из них считаются сутки и месяц."""

    __tablename__ = "traffic_samples"

    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("sources.id", ondelete="CASCADE"),
                                           index=True)
    used_bytes: Mapped[int] = mapped_column(Integer, default=0)


class NotificationSent(Base):
    """Чтобы одно и то же предупреждение не уходило дважды за день."""

    __tablename__ = "notifications_sent"
    __table_args__ = (UniqueConstraint("kind", "ref", "bucket", name="uq_notification"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(40))
    ref: Mapped[str] = mapped_column(String(60))
    bucket: Mapped[str] = mapped_column(String(24))
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class KnownDevice(Base):
    """Уже виденные HWID — чтобы поймать новое устройство на ключе."""

    __tablename__ = "known_devices"
    __table_args__ = (UniqueConstraint("user_ref", "hwid", name="uq_known_device"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_ref: Mapped[str] = mapped_column(String(120), index=True)
    hwid: Mapped[str] = mapped_column(String(120))
    platform: Mapped[str] = mapped_column(String(80), default="")
    model: Mapped[str] = mapped_column(String(120), default="")
    ip: Mapped[str] = mapped_column(String(64), default="")
    country: Mapped[str] = mapped_column(String(8), default="")
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
