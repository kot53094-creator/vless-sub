-- 0020_plans.sql
-- Тарифы и денежные поля журнала платежей (раздел 6 промта).
--
-- Таблица payments создана в 0019_payments.sql и хранит факт выдачи доступа
-- (kind, days, note). Здесь она расширяется денежными полями, а не создаётся
-- заново: так обе миграции применяются к одной таблице и не конфликтуют.
--
-- Платёжный провайдер намеренно НЕ подключён: по правилам проекта платные
-- сервисы не подключаются без явного подтверждения владельца. Строку с суммой
-- создаёт админ командой /pay уже после фактической оплаты (перевод, крипта).
-- Поля method/status/external_id оставлены на будущее: вебхук провайдера
-- сможет писать в ту же таблицу без новой миграции данных.
--
-- Применяется: wrangler d1 migrations apply vpn-hub-lite --remote

CREATE TABLE IF NOT EXISTS plans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT    NOT NULL UNIQUE,
  title        TEXT    NOT NULL,
  days         INTEGER NOT NULL DEFAULT 30 CHECK (days > 0),
  price_rub    INTEGER NOT NULL DEFAULT 0 CHECK (price_rub >= 0),
  device_limit INTEGER,
  traffic_gb   INTEGER,
  active       INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 100,
  note         TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_plans_active ON plans (active, sort, id);

-- SQLite разрешает ADD COLUMN только с константным DEFAULT, поэтому
-- paid_at заполняется в момент записи платежа, а не значением по умолчанию.
ALTER TABLE payments ADD COLUMN plan_code   TEXT;
ALTER TABLE payments ADD COLUMN amount_rub  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN currency    TEXT    NOT NULL DEFAULT 'RUB';
ALTER TABLE payments ADD COLUMN method      TEXT    NOT NULL DEFAULT 'manual';
ALTER TABLE payments ADD COLUMN status      TEXT    NOT NULL DEFAULT 'paid';
ALTER TABLE payments ADD COLUMN external_id TEXT;
ALTER TABLE payments ADD COLUMN actor       TEXT    NOT NULL DEFAULT '';
ALTER TABLE payments ADD COLUMN paid_at     TEXT;

-- Имена индексов не совпадают с 0019_payments.sql (idx_payments_user,
-- idx_payments_kind): CREATE INDEX IF NOT EXISTS с тем же именем молча
-- пропустился бы, и индекс остался бы другим.
CREATE INDEX IF NOT EXISTS idx_payments_money_user ON payments (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_payments_money_status ON payments (status, created_at DESC);

-- Базовые тарифы. Цены и лимиты — бизнес-решение владельца, поэтому здесь
-- нули/NULL: бот показывает «цена по договорённости», админ правит строки
-- в базе или админке. Пробный тариф — 7 дней, как и раньше в боте.
INSERT OR IGNORE INTO plans (code, title, days, price_rub, sort, note)
VALUES
  ('trial', 'Пробный', 7,   0, 10, 'Первый доступ на неделю'),
  ('month', 'Месяц',   30,  0, 20, 'Цену задаёт администратор'),
  ('year',  'Год',     365, 0, 30, 'Цену задаёт администратор');
