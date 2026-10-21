-- Служебное состояние бота: offset для getUpdates (резервный транспорт).
-- Храним в D1, а не в KV: KV на бесплатном плане даёт 1000 записей в сутки,
-- а смещение обновляется каждую минуту.
CREATE TABLE IF NOT EXISTS bot_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
