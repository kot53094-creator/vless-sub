-- Выбор сервера пользователем: он попадает первым в его подписке.
ALTER TABLE users ADD COLUMN preferred_server INTEGER;
ALTER TABLE users ADD COLUMN preferred_country TEXT;
