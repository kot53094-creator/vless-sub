-- Приоритет сервера: чем выше, тем раньше он в списке у пользователя.
ALTER TABLE servers ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
