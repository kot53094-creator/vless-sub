-- Временный общий доступ к источнику.
--
-- share_until задаёт момент, после которого источник снова считается
-- приватным. Проверка идёт при выдаче подписки, поэтому отдельный крон
-- не нужен: срок истёк — серверы сами перестали попадать другим людям.

ALTER TABLE sources ADD COLUMN share_until TEXT;

CREATE INDEX IF NOT EXISTS idx_sources_share_until ON sources (share_until);
