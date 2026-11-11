-- Разделяем два разных смысла проверки.
--
--   tcp    — открылся TCP-порт. Доказывает только доступность адреса.
--   tunnel — внешний агент поднял Xray и реально прошёл через туннель.
--
-- Без этого разделения стабильность сервера считалась по открытому порту,
-- и в «рабочие» попадали узлы, которые VPN-трафик не пропускают.
-- Старые строки остаются tcp: они и были портовыми.

ALTER TABLE server_checks ADD COLUMN kind TEXT NOT NULL DEFAULT 'tcp';

CREATE INDEX IF NOT EXISTS idx_checks_kind ON server_checks (server_id, kind, id DESC);
