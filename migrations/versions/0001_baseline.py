"""Базовая схема VPN Hub.

Revision ID: 0001_baseline
Revises:
Create Date: 2026-10-21

Схема повторяет модели (`hub/models.py`). `create_all` идемпотентен, поэтому
ревизию можно применять и к пустой базе, и к базе, созданной прошлыми версиями
через `init_db()`.
"""

from __future__ import annotations

from alembic import op

from hub.models import Base

revision = "0001_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    Base.metadata.create_all(bind=op.get_bind())


def downgrade() -> None:
    Base.metadata.drop_all(bind=op.get_bind())
