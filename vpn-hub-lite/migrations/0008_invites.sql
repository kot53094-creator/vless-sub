-- Инвайты: одноразовые ссылки, по которым человек получает подписку
-- с заранее заданными условиями (срок, трафик, устройства).

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  days       INTEGER NOT NULL DEFAULT 30,
  gb         INTEGER NOT NULL DEFAULT 0,
  devices    INTEGER NOT NULL DEFAULT 2,
  note       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  used_by    INTEGER,
  used_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_invites_created ON invites (created_at DESC);
