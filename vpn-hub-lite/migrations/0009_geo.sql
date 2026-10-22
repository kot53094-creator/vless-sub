-- География и человекочитаемые имена серверов.
-- Страна определяется по IP через внешний геолокатор и кэшируется в строке.

ALTER TABLE servers ADD COLUMN country_code TEXT;
ALTER TABLE servers ADD COLUMN country_name TEXT;
ALTER TABLE servers ADD COLUMN city TEXT;

CREATE INDEX IF NOT EXISTS idx_servers_country ON servers (country_code);
