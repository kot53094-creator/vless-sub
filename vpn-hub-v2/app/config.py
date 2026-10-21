"""Настройки из окружения. Ничего секретного в коде."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def _bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, "1" if default else "0").strip().lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    app_url: str = os.getenv("APP_URL", "http://localhost:8080").rstrip("/")
    secret_key: str = os.getenv("SECRET_KEY", "dev-insecure")
    admin_user: str = os.getenv("ADMIN_USER", "admin")
    admin_password_hash: str = os.getenv("ADMIN_PASSWORD_HASH", "")
    admin_password: str = os.getenv("ADMIN_PASSWORD", "")
    totp_secret: str = os.getenv("TOTP_SECRET", "")
    sub_token: str = os.getenv("SUB_TOKEN", "")

    data_dir: Path = Path(os.getenv("DATA_DIR", str(ROOT / "data")))
    database_url: str = ""

    fetch_ua: str = os.getenv("FETCH_UA", "Happ/2.9.1")
    fetch_interval_hours: int = _int("FETCH_INTERVAL_HOURS", 6)
    check_timeout: float = float(os.getenv("CHECK_TIMEOUT", "5"))
    check_workers: int = _int("CHECK_WORKERS", 12)

    detector_enabled: bool = _bool("DETECTOR_ENABLED", True)
    detector_interval: int = _int("DETECTOR_INTERVAL", 300)
    probe_ru_url: str = os.getenv("PROBE_RU_URL", "https://ya.ru/")
    probe_foreign_url: str = os.getenv("PROBE_FOREIGN_URL", "https://www.gstatic.com/generate_204")

    bot_token: str = os.getenv("BOT_TOKEN", "")
    admin_tg_id: str = os.getenv("ADMIN_TG_ID", "8938447065")
    channel_id: str = os.getenv("CHANNEL_ID", "")
    telegram_proxy: str = os.getenv("TELEGRAM_PROXY", "")

    remnawave_url: str = os.getenv("REMNAWAVE_URL", "").rstrip("/")
    remnawave_token: str = os.getenv("REMNAWAVE_TOKEN", "")
    trial_days: int = _int("TRIAL_DAYS", 3)
    trial_gb: int = _int("TRIAL_GB", 5)
    trial_devices: int = _int("TRIAL_DEVICES", 2)
    trial_squad: str = os.getenv("TRIAL_SQUAD", "")

    @property
    def people_enabled(self) -> bool:
        """Модуль B включается только наличием панели."""
        return bool(self.remnawave_url and self.remnawave_token)

    @property
    def bot_enabled(self) -> bool:
        return bool(self.bot_token)

    def db_url(self) -> str:
        if self.database_url:
            return self.database_url
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{self.data_dir / 'vpnhub.sqlite3'}"

    def warnings(self) -> list[str]:
        out: list[str] = []
        if not self.admin_password_hash and not self.admin_password:
            out.append("Не задан пароль админа: добавьте ADMIN_PASSWORD_HASH в .env")
        if not self.sub_token or len(self.sub_token) < 16:
            out.append("Не задан SUB_TOKEN: ссылка подписки не будет работать")
        if self.secret_key in ("dev-insecure", "change-me"):
            out.append("SECRET_KEY остался стандартным — замените на случайный")
        if not self.remnawave_url:
            out.append("Панель Remnawave не подключена: раздел «Люди» выключен")
        return out


settings = Settings()
