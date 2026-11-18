-- Скорость узла, замеренная агентом (Мбит/с).
--
-- Колонка использовалась кодом (`sub.ts`, `admin_stats.ts`, `checks_api.ts`),
-- но в миграциях её не было: её добавили в рабочую базу вручную. Из-за этого
-- свежая установка из миграций падала на `SELECT s.speed_mbps`, а локальный
-- запуск без облака не поднимался вовсе.
--
-- На существующей базе колонка уже есть. Чтобы `wrangler d1 migrations apply`
-- не упал на «duplicate column name», отметьте миграцию применённой вручную:
--   npx wrangler d1 execute vpn-hub-lite --remote --command \
--     "INSERT INTO d1_migrations (name) VALUES ('0021_speed_mbps.sql')"

ALTER TABLE servers ADD COLUMN speed_mbps REAL;
