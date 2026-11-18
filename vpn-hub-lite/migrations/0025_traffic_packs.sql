-- 0025_traffic_packs.sql
-- Докупка трафика сверх тарифа.
--
-- Почему отдельная таблица, а не строка в plans: тариф продаёт СРОК, пакет
-- продаёт ГИГАБАЙТЫ. У них разная логика выдачи (дни против квоты), разный
-- срок жизни и разная отчётность. Смешать их в plans — значит в отчёте по
-- выручке складывать дни с гигабайтами.
--
-- `traffic_extra_gb` — докупленное сверх базовой квоты. База остаётся в
-- `traffic_gb`, поэтому видно, что человек купил, а что ему дал тариф.
--
-- Применяется: npx wrangler d1 migrations apply vpn-hub-lite --remote

CREATE TABLE IF NOT EXISTS traffic_packs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE,
  gb         INTEGER NOT NULL CHECK (gb > 0),
  price_rub  INTEGER NOT NULL CHECK (price_rub >= 0),
  title      TEXT    NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 10
);

ALTER TABLE users ADD COLUMN traffic_extra_gb INTEGER NOT NULL DEFAULT 0;

-- Стартовая сетка. Цена за гигабайт падает с объёмом — иначе крупный пакет
-- никто не возьмёт.
INSERT OR IGNORE INTO traffic_packs (code, gb, price_rub, title, sort) VALUES
  ('gb10',  10,  99,  '+10 ГБ',  10),
  ('gb50',  50, 349,  '+50 ГБ',  20),
  ('gb100', 100, 599, '+100 ГБ', 30);
