-- 0023_devices_traffic.sql
-- Лимит устройств и учёт израсходованного трафика.
--
-- 1. Устройства. Раньше `blocked` означал только «человек сам отвязал».
--    Теперь блокировка бывает двух причин, и в подписке нужно объяснить,
--    какая именно: ручная или превышение лимита. Причина хранится рядом,
--    чтобы клиент получил «Лимит устройств (2) — отвяжите лишнее», а не
--    общее «устройство отключено».
--
-- 2. Трафик. Cloudflare Worker не видит объём, прошедший через туннель,
--    поэтому счётчик наполняет агент на своих узлах (Xray stats API) через
--    POST /api/traffic. Здесь — только место, где этот счётчик живёт.
--    `traffic_used_mb` накапливается, `traffic_reset_at` — дата последнего
--    обнуления (раз в 30 дней, по cron).
--
-- Применяется: npx wrangler d1 migrations apply vpn-hub-lite --remote

ALTER TABLE user_devices ADD COLUMN blocked_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE user_devices ADD COLUMN blocked_at TEXT;

-- Быстрый подсчёт активных устройств: именно он решает, пустить третье или нет.
CREATE INDEX IF NOT EXISTS idx_user_devices_active
  ON user_devices (user_id, blocked, last_seen DESC);

ALTER TABLE users ADD COLUMN traffic_used_mb REAL NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN traffic_reset_at TEXT;
ALTER TABLE users ADD COLUMN traffic_reported_at TEXT;

-- Базовый тариф — два устройства. Это осознанное ограничение: третье
-- устройство получает заглушку с текстом про лимит и кнопку «отвязать»
-- в кабинете. Старшие тарифы могут выдавать больше (3/4/5).
UPDATE plans SET device_limit = 2 WHERE code = 'month';
