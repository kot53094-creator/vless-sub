-- Мягкий лимит трафика на пользователя (гигабайты).
-- Жёстко не блокирует: используется для отображения и предупреждений.
ALTER TABLE users ADD COLUMN traffic_gb INTEGER NOT NULL DEFAULT 0;
