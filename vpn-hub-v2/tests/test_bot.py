"""Права админа, лимит частоты и тексты бота."""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.bot import access
from app.bot.texts import (
    DEFAULT_INSTRUCTIONS,
    DEVICE_TITLES,
    WELCOME_BUTTONS,
    device_menu,
    instruction,
)
from app.config import settings
from app.models import Base, Setting


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()


def test_admin_is_only_one():
    original = settings.admin_tg_id
    try:
        object.__setattr__(settings, "admin_tg_id", "42")
        assert access.is_admin(42) is True
        assert access.is_admin(43) is False
        assert access.is_admin(None) is False
    finally:
        object.__setattr__(settings, "admin_tg_id", original)


def test_rate_limit_blocks_after_limit():
    access.reset()
    for _ in range(5):
        assert access.rate_ok(7, limit=5, window=60) is True
    assert access.rate_ok(7, limit=5, window=60) is False
    # другой пользователь не страдает
    assert access.rate_ok(8, limit=5, window=60) is True


def test_default_instructions_cover_all_devices():
    assert set(DEFAULT_INSTRUCTIONS) == set(DEVICE_TITLES)
    for text in DEFAULT_INSTRUCTIONS.values():
        assert 3 <= len(text.splitlines()) <= 5
        assert "Happ" in text


def test_instruction_override_from_settings(db):
    db.merge(Setting(key="instruction.android", value="Свой текст"))
    db.commit()
    assert instruction(db, "android") == "Свой текст"
    assert instruction(db, "ios") == DEFAULT_INSTRUCTIONS["ios"]


def test_device_menu_has_all_buttons():
    buttons = [label for row in device_menu() for label, _ in row]
    # пять устройств + «Назад»
    assert len(buttons) == len(DEVICE_TITLES) + 1
    assert "Android" in buttons and "← Назад" in buttons


def test_welcome_buttons_are_actions():
    callbacks = [data for row in WELCOME_BUTTONS for _, data in row]
    assert all(data.startswith("act:") for data in callbacks)
    assert "act:devices" in callbacks
    assert "act:cabinet" in callbacks
