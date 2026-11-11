-- Журнал выдачи подписок: таблица payments из раздела 6 промта.
--
-- Онлайн-оплаты в сервисе нет: платёжный провайдер подключается только после
-- явного подтверждения владельца (промт запрещает подключать платные
-- сервисы молча). Но каждая выдача доступа — ручное продление, одобрение,
-- выдача из панели — уже событие, которое хочется видеть в одном месте:
-- кто, когда и на сколько дней получил подписку. Копим их здесь.
--
-- kind: manual — выдано админом руками (бот /extend, /approve, панель);
--       promo  — зарезервировано для промо-выдач;
--       online — зарезервировано на случай будущей онлайн-оплаты.

CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL DEFAULT 'manual',
  days       INTEGER NOT NULL DEFAULT 0,
  note       TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payments_user
  ON payments (user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_payments_kind
  ON payments (kind, created_at);
