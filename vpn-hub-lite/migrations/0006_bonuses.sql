-- Бонусы, рефералы, промокоды, баннеры, журнал начислений.
-- Применяется: wrangler d1 migrations apply vpn-hub-lite --remote

-- Настройки, которые правятся в админке без редеплоя.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 7 баннеров. Байты лежат в KV (banner:<key>), здесь — только file_id.
CREATE TABLE IF NOT EXISTS banners (
  key        TEXT PRIMARY KEY,
  file_id    TEXT NOT NULL DEFAULT '',
  caption    TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Единый журнал начислений. UNIQUE(ref) — это и есть идемпотентность.
CREATE TABLE IF NOT EXISTS accruals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL,
  ref          TEXT    UNIQUE,
  days         REAL    NOT NULL DEFAULT 0,
  hours        REAL    NOT NULL DEFAULT 0,
  gb           REAL    NOT NULL DEFAULT 0,
  squad        TEXT,
  note         TEXT    NOT NULL DEFAULT '',
  status       TEXT    NOT NULL DEFAULT 'applied'
                       CHECK (status IN ('applied', 'cancelled')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_accruals_user ON accruals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_accruals_kind ON accruals (kind, created_at DESC);

-- Одна строка на пользователя в сутки (сутки по Москве).
CREATE TABLE IF NOT EXISTS daily_claims (
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  claim_date TEXT    NOT NULL,
  streak     INTEGER NOT NULL DEFAULT 1,
  hours      REAL    NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, claim_date)
);

CREATE TABLE IF NOT EXISTS referrals (
  invited_id  INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  inviter_id  INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code        TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'rewarded', 'capped', 'cancelled')),
  rewarded_at TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_referrals_inviter ON referrals (inviter_id);

CREATE TABLE IF NOT EXISTS promos (
  code           TEXT PRIMARY KEY,
  days           REAL    NOT NULL DEFAULT 0,
  hours          REAL    NOT NULL DEFAULT 0,
  gb             REAL    NOT NULL DEFAULT 0,
  squad          TEXT,
  squad_days     INTEGER NOT NULL DEFAULT 0,
  max_uses       INTEGER NOT NULL DEFAULT 0,  -- 0 = без общего лимита
  used           INTEGER NOT NULL DEFAULT 0,
  per_user_limit INTEGER NOT NULL DEFAULT 1,
  expires_at     TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promo_uses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  accrual_id INTEGER,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (code, user_id)
);

-- Группы серверов (squads). Default — обычные, Bypass — обход белых списков.
CREATE TABLE IF NOT EXISTS user_squads (
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  squad      TEXT    NOT NULL,
  expires_at TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, squad)
);

-- Дедупликация уведомлений: одна и та же новость не уходит дважды.
CREATE TABLE IF NOT EXISTS notify_log (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind    TEXT    NOT NULL,
  period  TEXT    NOT NULL,
  sent_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind, period)
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('daily_enabled',          '1'),
  ('daily_bonus_hours',      '1'),
  ('daily_streak3_hours',    '2'),
  ('daily_streak7_hours',    '3'),
  ('daily_month_cap_hours',  '48'),
  ('channel_reward_days',    '1'),
  ('referral_enabled',       '1'),
  ('referral_reward_days',   '1'),
  ('referral_reward_inviter','1'),
  ('referral_month_cap_days','30'),
  ('referral_requires_active','1'),
  ('promo_enabled',          '1'),
  ('squads_enabled',         '0'),
  ('notify_expiring',        '1'),
  ('notify_days_before',     '1'),
  ('notify_comeback',        '1'),
  ('comeback_days',          '3'),
  ('clicker_enabled',        '0'),
  ('clicker_daily_cap_hours','3');

INSERT OR IGNORE INTO banners (key, caption) VALUES
  ('start',     ''),
  ('trial',     ''),
  ('channel',   ''),
  ('devices',   ''),
  ('account',   ''),
  ('activated', ''),
  ('expiring',  '');
