"""Новые устройства на ключах Remnawave: сравнение по HWID, а не по счёту."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import KnownDevice, utcnow
from . import notifier


async def watch(db: Session, user_ref: str, devices: list, notify: bool = True) -> list[str]:
    """devices — объекты с полями hwid/platform/model/ip/country."""
    fresh: list = []
    for device in devices:
        hwid = (getattr(device, "hwid", "") or "").strip()
        if not hwid:
            continue
        row = db.execute(
            select(KnownDevice).where(
                KnownDevice.user_ref == user_ref, KnownDevice.hwid == hwid
            )
        ).scalar_one_or_none()
        if row:
            row.last_seen = utcnow()
            if getattr(device, "ip", ""):
                row.ip = device.ip
            if getattr(device, "platform", ""):
                row.platform = device.platform
        else:
            db.add(KnownDevice(
                user_ref=user_ref,
                hwid=hwid,
                platform=(getattr(device, "platform", "") or "")[:80],
                model=(getattr(device, "model", "") or "")[:120],
                ip=(getattr(device, "ip", "") or "")[:64],
                country=(getattr(device, "country", "") or "")[:8],
            ))
            fresh.append(device)
    db.commit()

    sent: list[str] = []
    for device in fresh:
        text = notifier.format_device(
            user_ref,
            getattr(device, "model", "") or getattr(device, "platform", "") or "устройство",
            getattr(device, "ip", ""),
            getattr(device, "country", ""),
        )
        if notify:
            await notifier.send(text)
        sent.append(text)
    return sent


async def watch_counts(db: Session, counts: dict[str, int], notify: bool = True) -> list[str]:
    """Запасной путь: если панель не отдаёт HWID, ловим рост числа устройств."""
    from ..models import Setting
    import json

    row = db.get(Setting, "device_snapshot")
    previous = json.loads(row.value) if row and row.value else {}
    sent: list[str] = []
    for user, count in counts.items():
        old = int(previous.get(user, count))
        if count > old:
            text = notifier.format_device(user, f"{count} устройств", "", "")
            if notify:
                await notifier.send(text)
            sent.append(text)
    merged = {**previous, **counts}
    snap = db.get(Setting, "device_snapshot") or Setting(key="device_snapshot")
    snap.value = json.dumps(merged)
    db.merge(snap)
    db.commit()
    return sent
