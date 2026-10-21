"""Базовая схема VPN Hub.

revision = 0001_baseline
"""

from __future__ import annotations

from alembic import op

from app.models import Base

revision = "0001_baseline"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    Base.metadata.create_all(bind=op.get_bind())


def downgrade() -> None:
    Base.metadata.drop_all(bind=op.get_bind())
