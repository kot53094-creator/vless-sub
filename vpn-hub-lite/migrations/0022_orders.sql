-- 0022_orders.sql
-- Платный контур: заказы, цены в звёздах, витрина тарифов.
--
-- До этой миграции деньги существовали только как запись «админ принял
-- оплату» в payments. Заказ (orders) — это отдельная сущность: он создаётся
-- ДО оплаты, живёт в статусе pending, получает external_id от провайдера и
-- только после подтверждения превращается в продление подписки.
--
-- Почему отдельная таблица, а не строка в payments:
--   1. payments — бухгалтерский журнал фактов, orders — состояние оплаты;
--      смешивать их значит потерять и то, и другое при первом возврате.
--   2. Провайдеру нужен свой идентификатор и своя цена в его валюте
--      (звёзды, рубли, USDT) — в payments такого места нет.
--   3. Идемпотентность вебхука держится на UNIQUE (provider, external_id):
--      повторная доставка того же уведомления не продлит доступ дважды.
--
-- Применяется: npx wrangler d1 migrations apply vpn-hub-lite --remote

CREATE TABLE IF NOT EXISTS orders (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Публичный идентификатор: попадает в payload провайдера и в ссылку
  -- /pay/<id>. Внутренний id наружу не отдаём, чтобы нельзя было перебрать
  -- чужие заказы.
  public_id          TEXT    NOT NULL UNIQUE,
  user_id            INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plan_code          TEXT    NOT NULL,
  plan_title         TEXT    NOT NULL DEFAULT '',
  days               INTEGER NOT NULL DEFAULT 0 CHECK (days >= 0),
  device_limit       INTEGER,
  traffic_gb         INTEGER,
  -- Сколько стоит заказ в рублях (витрина) и в валюте провайдера.
  amount_rub         INTEGER NOT NULL DEFAULT 0 CHECK (amount_rub >= 0),
  amount_minor       INTEGER NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  currency           TEXT    NOT NULL DEFAULT 'RUB',
  provider           TEXT    NOT NULL,
  -- pending → paid | failed | canceled | expired → refunded
  status             TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'paid', 'failed', 'canceled', 'expired', 'refunded')),
  external_id        TEXT,
  -- Идентификаторы для возврата: у Stars это telegram_payment_charge_id.
  telegram_charge_id TEXT,
  provider_charge_id TEXT,
  -- Промокод/скидка, применённые к заказу (код, не сумма).
  promo_code         TEXT    NOT NULL DEFAULT '',
  note               TEXT    NOT NULL DEFAULT '',
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  paid_at            TEXT,
  refunded_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status, created_at DESC);
-- Один внешний платёж = один заказ. NULL не участвует в уникальности,
-- поэтому непривязанные заказы не мешают друг другу.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_external
  ON orders (provider, external_id) WHERE external_id IS NOT NULL;

-- Цена в звёздах задаётся отдельно: курс рубля к Star меняется, и владелец
-- должен иметь возможность зафиксировать цену в звёздах, не трогая рубли.
-- NULL — считать автоматически по STAR_RUB из окружения.
ALTER TABLE plans ADD COLUMN price_stars INTEGER;
-- Короткая метка на витрине: «Хит», «Выгодно», «−35%». Пусто — нет метки.
ALTER TABLE plans ADD COLUMN badge TEXT NOT NULL DEFAULT '';
-- 1 — тариф выделяется на витрине и в боте как рекомендуемый.
ALTER TABLE plans ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;

-- Витрина для продажи. Цены — стартовые: владелец меняет их в админке или
-- SQL, код к ним не привязан. Пробный тариф остаётся бесплатным (0 ₽) и
-- управляется отдельным флагом TRIVAL_DAYS, а не этой таблицей.
UPDATE plans SET price_rub = 190,  days = 30,  device_limit = 3, traffic_gb = NULL,
       badge = '',            featured = 1, note = 'Все серверы, безлимитный трафик, 3 устройства'
 WHERE code = 'month' AND price_rub = 0;
UPDATE plans SET price_rub = 1490, days = 365, device_limit = 5, traffic_gb = NULL,
       badge = '−35%',        featured = 0, note = 'Год без продлений, 5 устройств, поддержка в приоритете'
 WHERE code = 'year' AND price_rub = 0;

INSERT OR IGNORE INTO plans (code, title, days, price_rub, device_limit, traffic_gb, active, sort, badge, featured, note)
VALUES
  ('quarter', '3 месяца',  90,  490,  4, NULL, 1, 25, '−15%', 0,
   'Скидка 15%, 4 устройства, перенос на новый сервер в один тап'),
  ('half',    '6 месяцев', 180, 890,  5, NULL, 1, 27, '−25%', 0,
   'Скидка 25%, 5 устройств, приоритетная поддержка');
