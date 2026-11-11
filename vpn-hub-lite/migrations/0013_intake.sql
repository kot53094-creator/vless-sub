-- Учёт импорта и версии подписок.
--
-- import_runs  — что именно пришло от источника: сколько строк, сколько
--                разобралось, сколько попало в REALITY-выдачу и по каким
--                причинам остальное отклонено. Нужен для статистики
--                источников и разбора «почему серверов нет».
-- sub_versions — снимок выданного набора серверов. По нему видно, что
--                человек получал раньше, и можно откатиться, если новое
--                обновление оказалось хуже. Последняя версия не удаляется.

CREATE TABLE IF NOT EXISTS import_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  ran_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  ok          INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  lines       INTEGER NOT NULL DEFAULT 0,
  parsed      INTEGER NOT NULL DEFAULT 0,
  accepted    INTEGER NOT NULL DEFAULT 0,
  publishable INTEGER NOT NULL DEFAULT 0,
  rejects     TEXT    NOT NULL DEFAULT '{}',
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_import_runs_source ON import_runs (source_id, ran_at DESC);

CREATE TABLE IF NOT EXISTS sub_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  fingerprint TEXT    NOT NULL,
  server_ids  TEXT    NOT NULL,
  count       INTEGER NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  note        TEXT    NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_versions_ver ON sub_versions (user_id, version);
CREATE INDEX IF NOT EXISTS idx_sub_versions_user ON sub_versions (user_id, id DESC);
