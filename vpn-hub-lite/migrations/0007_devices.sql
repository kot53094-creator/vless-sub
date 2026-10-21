-- Устройства: имя клиента, последняя активность, индивидуальная блокировка.
-- Ключ устройства — соль+хеш User-Agent, сам UA не хранится.

CREATE TABLE IF NOT EXISTS user_devices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_key TEXT    NOT NULL,
  label      TEXT    NOT NULL,
  first_seen TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT    NOT NULL DEFAULT (datetime('now')),
  blocked    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, device_key)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user
  ON user_devices (user_id, blocked, last_seen DESC);
