-- Слоты устройств на источнике.
-- У платного ключа может быть всего 3 устройства: max_devices = 3.
-- Тогда серверы этого источника попадают только тем, кому админ выдал слот.
ALTER TABLE sources ADD COLUMN max_devices INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS user_sources (
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_id  INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_user_sources_source ON user_sources (source_id);
