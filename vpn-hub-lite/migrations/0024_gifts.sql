-- 0024_gifts.sql
-- Подарочные коды — первая функция, перенятая у Faoxima (PHP-бот продаж).
--
-- Зачем отдельная таблица, а не промокод: промокод даёт скидку на покупку,
-- а подарочный код выдаёт готовые дни и не требует оплаты. Смешивать их в
-- одной таблице — значит однажды продать «скидку 100%» вместо подарка.
--
-- Одноразовость держится на `redeemed_by IS NULL` в UPDATE: два человека,
-- нажавшие «активировать» одновременно, не получат дни дважды.

CREATE TABLE IF NOT EXISTS gift_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,
  days        INTEGER NOT NULL CHECK (days > 0),
  note        TEXT    NOT NULL DEFAULT '',
  created_by  INTEGER,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT,
  redeemed_by INTEGER,
  redeemed_at TEXT,
  -- Кто именно получил дни: useful при разборе «код сказали, что не сработал».
  redeemed_tg TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_gifts_free ON gift_codes (redeemed_by, expires_at);
