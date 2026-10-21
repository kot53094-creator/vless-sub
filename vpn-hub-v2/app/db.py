"""SQLite, сессии, мелкие миграции-«заплатки»."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from .config import settings
from .models import Base

connect_args = {"check_same_thread": False} if settings.db_url().startswith("sqlite") else {}
engine = create_engine(settings.db_url(), connect_args=connect_args, future=True, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)

if settings.db_url().startswith("sqlite"):

    @event.listens_for(engine, "connect")
    def _pragmas(conn, _record):  # pragma: no cover
        cur = conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()


# Колонки, добавленные после первого релиза: ALTER TABLE для существующих баз.
EXTRA_COLUMNS: dict[str, dict[str, str]] = {
    "sources": {
        "days_manual": "INTEGER",
        "visibility": "VARCHAR(20) DEFAULT 'shareable'",
        "hwid": "VARCHAR(64) DEFAULT ''",
    },
    "people": {
        "squad": "VARCHAR(80) DEFAULT ''",
        "remnawave_uuid": "VARCHAR(64) DEFAULT ''",
        "trial_used": "INTEGER DEFAULT 0",
    },
}


def init_db() -> None:
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        tables = set(inspect(conn).get_table_names())
        for table, columns in EXTRA_COLUMNS.items():
            if table not in tables:
                continue
            existing = {col["name"] for col in inspect(conn).get_columns(table)}
            for name, ddl in columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
