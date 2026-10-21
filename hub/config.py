"""Настройки хаба: читаются из окружения (.env), ничего не хранится в коде."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, "1" if default else "0").strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    # --- общее
    app_name: str = os.getenv("HUB_APP_NAME", "VPN Hub")
    # В Docker это /data, локально — папка data рядом с проектом.
    data_dir: Path = Path(os.getenv("HUB_DATA_DIR") or (ROOT / "data"))
    database_url: str = ""
    secret_key: str = os.getenv("HUB_SECRET_KEY", "")
    sub_token: str = os.getenv("HUB_SUB_TOKEN", "")
    public_base_url: str = os.getenv("HUB_PUBLIC_URL", "http://localhost:8080")

    # --- вход
    admin_user: str = os.getenv("HUB_ADMIN_USER", "admin")
    admin_password: str = os.getenv("HUB_ADMIN_PASSWORD", "")
    admin_password_hash: str = os.getenv("HUB_ADMIN_PASSWORD_HASH", "")
    session_hours: int = int(os.getenv("HUB_SESSION_HOURS", "72"))

    # --- синхронизация
    # Встроенный планировщик. Выключите, если синхронизацию запускает
    # systemd-таймер или cron — иначе прогоны будут дублироваться.
    scheduler_enabled: bool = _bool("HUB_SCHEDULER_ENABLED", True)
    sync_interval_hours: int = int(os.getenv("HUB_SYNC_INTERVAL_HOURS", "6"))
    fetch_timeout: int = int(os.getenv("HUB_FETCH_TIMEOUT", "20"))
    check_timeout: float = float(os.getenv("HUB_CHECK_TIMEOUT", "6"))
    check_attempts: int = int(os.getenv("HUB_CHECK_ATTEMPTS", "3"))
    check_workers: int = int(os.getenv("HUB_CHECK_WORKERS", "16"))
    user_agent: str = os.getenv("HUB_USER_AGENT", "Happ/2.9.1")

    # --- детектор белых списков (этап 4)
    detector_enabled: bool = _bool("HUB_DETECTOR_ENABLED", False)
    detector_interval: int = int(os.getenv("HUB_DETECTOR_INTERVAL", "300"))
    probe_ru_url: str = os.getenv("HUB_PROBE_RU_URL", "https://ya.ru/")
    probe_foreign_url: str = os.getenv("HUB_PROBE_FOREIGN_URL", "https://www.google.com/generate_204")

    # --- Remnawave (этап 2)
    remnawave_url: str = os.getenv("REMNAWAVE_URL", "")
    remnawave_token: str = os.getenv("REMNAWAVE_TOKEN", "")

    # --- Telegram
    telegram_token: str = os.getenv("TELEGRAM_BOT_TOKEN", "")
    telegram_chat: str = os.getenv("TELEGRAM_CHAT_ID", "")

    @property
    def db_path(self) -> Path:
        return self.data_dir / "hub.sqlite3"

    def resolved_db_url(self) -> str:
        if self.database_url:
            return self.database_url
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:  # нет прав на /data вне Docker
            print(f"[warn] не удалось создать {self.data_dir}: {exc}", flush=True)
        return f"sqlite:///{self.db_path}"

    def warnings(self) -> list[str]:
        out = []
        if not self.secret_key:
            out.append("HUB_SECRET_KEY не задан — сессии будут сбрасываться при рестарте")
        if not self.sub_token:
            out.append("HUB_SUB_TOKEN не задан — ссылка подписки не будет работать")
        if not (self.admin_password or self.admin_password_hash):
            out.append("Пароль администратора не задан — вход невозможен")
        return out


settings = Settings()
