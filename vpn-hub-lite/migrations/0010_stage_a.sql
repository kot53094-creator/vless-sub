-- Этап A: тарифные категории, ручное вкл/выкл, история проверок.

ALTER TABLE servers ADD COLUMN tier TEXT NOT NULL DEFAULT 'free';
ALTER TABLE servers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free';

CREATE TABLE IF NOT EXISTS server_checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id  INTEGER NOT NULL,
  checked_at TEXT    NOT NULL DEFAULT (datetime('now')),
  result     TEXT    NOT NULL,
  latency_ms INTEGER,
  error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_checks_server ON server_checks (server_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_servers_enabled ON servers (enabled, status);
