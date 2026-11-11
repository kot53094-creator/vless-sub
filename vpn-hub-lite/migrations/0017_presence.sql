-- Присутствие: включён ли у человека туннель в момент последнего обращения.
--
-- Логика честная: Worker не видит трафик пользователя — он идёт напрямую
-- на чужой узел. Единственное, что мы видим, — запрос подписки. Если он
-- пришёл с IP, который является выходом одного из наших узлов, значит в этот
-- момент клиент реально гнал трафик через туннель.
--
-- Поэтому у узла нужен его настоящий выходной IP (exit_ip), а не hostname:
-- у CDN-фронтов и цепочек они различаются.

ALTER TABLE servers ADD COLUMN exit_ip TEXT;

CREATE TABLE IF NOT EXISTS user_presence (
  user_id     INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  state       TEXT    NOT NULL DEFAULT 'off'
                      CHECK (state IN ('on', 'off')),
  ip_hash     TEXT    NOT NULL DEFAULT '',
  via_host    TEXT    NOT NULL DEFAULT '',
  via_country TEXT    NOT NULL DEFAULT '',
  via_server  INTEGER,
  source      TEXT    NOT NULL DEFAULT 'sub',
  last_seen   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_on_at  TEXT,
  last_off_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_presence_seen ON user_presence (last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_servers_exit ON servers (exit_ip);
