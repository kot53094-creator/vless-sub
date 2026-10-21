-- VPN Hub Lite: базовая схема D1.
-- Применяется командой: wrangler d1 migrations apply vpn-hub-lite --remote

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id         TEXT    NOT NULL UNIQUE,
  tg_username   TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'active', 'banned', 'expired')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT,
  device_limit  INTEGER NOT NULL DEFAULT 2,
  sub_token     TEXT    NOT NULL UNIQUE,
  last_fetch_at TEXT,
  note          TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX idx_users_status ON users (status);
CREATE INDEX idx_users_token  ON users (sub_token);

CREATE TABLE sources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  kind          TEXT    NOT NULL DEFAULT 'public'
                        CHECK (kind IN ('own_vps', 'trial', 'public', 'bridge_ru', 'cdn_xhttp', 'paid_private')),
  url_or_link   TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT,
  traffic_total INTEGER,
  traffic_used  INTEGER,
  status        TEXT    NOT NULL DEFAULT 'unknown'
                        CHECK (status IN ('alive', 'dead', 'unknown')),
  latency_ms    INTEGER,
  last_check_at TEXT,
  last_sync_at  TEXT,
  visibility    TEXT    NOT NULL DEFAULT 'shareable'
                        CHECK (visibility IN ('private', 'shareable')),
  last_error    TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX idx_sources_sync ON sources (last_sync_at);

CREATE TABLE servers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  remark        TEXT    NOT NULL DEFAULT '',
  link          TEXT    NOT NULL,
  host          TEXT    NOT NULL,
  port          INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'unknown'
                        CHECK (status IN ('alive', 'dead', 'unknown')),
  latency_ms    INTEGER,
  last_check_at TEXT,
  max_users     INTEGER NOT NULL DEFAULT 10,
  seen_at       TEXT,
  UNIQUE (source_id, host, port)
);
CREATE INDEX idx_servers_status ON servers (status);
CREATE INDEX idx_servers_check  ON servers (last_check_at);

CREATE TABLE pools (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE pool_servers (
  pool_id   INTEGER NOT NULL REFERENCES pools (id) ON DELETE CASCADE,
  server_id INTEGER NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  PRIMARY KEY (pool_id, server_id)
);

CREATE TABLE user_pools (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  pool_id INTEGER NOT NULL REFERENCES pools (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, pool_id)
);

CREATE TABLE assignments (
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  server_id   INTEGER NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  assigned_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, server_id)
);
CREATE INDEX idx_assign_server ON assignments (server_id);

CREATE TABLE events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL DEFAULT (datetime('now')),
  type    TEXT NOT NULL,
  user_id INTEGER,
  details TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_events_ts ON events (ts DESC);

CREATE TABLE fetch_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  ts_hour  TEXT    NOT NULL,
  ip_hash  TEXT    NOT NULL,
  ua_hash  TEXT    NOT NULL
);
CREATE INDEX idx_fetch_user_hour ON fetch_log (user_id, ts_hour);

-- paid_private всегда private, даже если код попытается записать иначе.
CREATE TRIGGER trg_sources_private_insert
AFTER INSERT ON sources
WHEN NEW.kind = 'paid_private' AND NEW.visibility <> 'private'
BEGIN
  UPDATE sources SET visibility = 'private' WHERE id = NEW.id;
END;

CREATE TRIGGER trg_sources_private_update
AFTER UPDATE OF kind, visibility ON sources
WHEN NEW.kind = 'paid_private' AND NEW.visibility <> 'private'
BEGIN
  UPDATE sources SET visibility = 'private' WHERE id = NEW.id;
END;
