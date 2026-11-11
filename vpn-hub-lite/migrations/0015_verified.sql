-- Отдельные поля для настоящей проверки туннеля.
--
-- latency_ms / last_check_at принадлежат TCP-проверке (health, раз в 20 минут).
-- Если писать туда же результаты Xray-агента, они затираются в течение часа,
-- и «проверено» начинает означать «порт открылся». Поэтому у туннеля свои
-- поля: verified_at и verified_latency_ms. Пусто — значит туннель не проверяли.

ALTER TABLE servers ADD COLUMN verified_at TEXT;
ALTER TABLE servers ADD COLUMN verified_latency_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_servers_verified ON servers (verified_at);
