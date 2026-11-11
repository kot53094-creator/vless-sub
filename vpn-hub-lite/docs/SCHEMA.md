# Схема базы

База — SQLite: D1 на Cloudflare, при необходимости Turso/libSQL. Диалект,
миграции и запросы одинаковые, поэтому схема не привязана к хостингу.

## 1. Как менять схему

- Миграции лежат в `migrations/NNNN_название.sql` и применяются по порядку.
- `wrangler d1 migrations apply` ведёт служебную таблицу `d1_migrations`:
  повторно один файл не применяется.
- Файлы не переписываются после применения. Исправление — новая миграция.
- Номер уникален: два файла с одним номером (`0019_...`) — ошибка, а не
  «оба применятся». Если два процесса добавили миграции одновременно, номера
  согласуются вручную.
- `CREATE TABLE IF NOT EXISTS` и `CREATE INDEX IF NOT EXISTS` обязательны:
  так миграция переживает частично применённую базу.
- `ALTER TABLE ... ADD COLUMN` в SQLite не принимает непостоянный `DEFAULT`
  (`datetime('now')`) и `UNIQUE`/`PRIMARY KEY`. Поэтому новые денежные поля
  добавлены обычными колонками с константным `DEFAULT`, а дата заполняется
  запросом.
- Имена индексов глобальны. Нельзя переиспользовать имя из другой миграции:
  `IF NOT EXISTS` молча оставит старый индекс с другим набором колонок.

Применение:

```bash
npm run db:migrate          # D1, удалённая база
npm run db:migrate:local    # локальная D1 для wrangler dev
```

Если источник истины — Turso, миграции накатываются отдельно:

```bash
for f in migrations/*.sql; do turso db shell vpn-hub < "$f"; done
```

## 2. Таблицы промта → фактические таблицы

| Сущность из требований | Где живёт | Комментарий |
|---|---|---|
| Пользователи | `users` | Telegram, статус, срок, токен подписки, лимит устройств |
| Подписки | `users` + `sub_versions` | текущий срок в `users`, история состава — в `sub_versions` |
| Тарифы | `plans` | код, срок, цена, лимиты; цены правит владелец |
| Платежи | `payments` | факт выдачи (`kind`, `days`) + деньги (`amount_rub`, `method`, `status`) |
| Серверы / узлы | `servers` | ссылка, хост, порт, статус, гео, приоритет |
| Источники | `sources` | URL или одиночный ключ, видимость, слоты |
| Проверки | `server_checks` | `kind='tcp'` и `kind='tunnel'` — разные уровни |
| Выдача серверов | `assignments` | какие узлы закреплены за человеком |
| Группы серверов | `pools`, `pool_servers`, `user_pools` | пулы и доступ людей |
| Слоты приватных источников | `user_sources` | кто занимает ограниченный источник |
| События / аудит | `events` | журнал действий, best-effort |
| Настройки | `settings` | правки без редеплоя |
| Промокоды | `promos`, `promo_uses` | коды и факты активации |
| Начисления | `accruals` | единый журнал, `UNIQUE(ref)` — идемпотентность |
| Ежедневный бонус | `daily_claims` | серия и дата последнего получения |
| Рефералы | `referrals` | кто кого пригласил и награда |
| Инвайты | `invites` | одноразовые коды |
| Устройства | `user_devices`, `fetch_log` | устройства по хэшу UA и учёт запросов |
| Присутствие | `user_presence` | включён ли VPN сейчас (диагностика) |
| Уведомления | `notify_log` | защита от повторных сообщений |
| Импорт | `import_runs` | статистика прогонов и причины отказа |
| Баннеры | `banners` | `file_id` в Telegram, байты — в KV |
| Состояние бота | `bot_state` | временные диалоги (не бэкапится) |
| Группы Bypass | `user_squads` | выданные squad-группы |

## 3. Ключевые связи

```
sources 1──n servers 1──n server_checks
servers n──n pools            (pool_servers)
users   1──n assignments n──1 servers
users   1──n user_pools n──1 pools
users   1──n user_sources n──1 sources
users   1──n payments
users   1──n accruals / referrals / invites / user_devices / sub_versions
```

- Внешние ключи объявлены с `ON DELETE CASCADE` там, где строка без родителя
  бессмысленна (платежи, устройства, версии подписок).
- `assignments` и `pool_servers` имеют составные первичные ключи — дубликаты
  невозможны на уровне схемы.
- `servers` уникальны по `(source_id, host, port)`: повторный импорт обновляет
  строку, а не плодит копии.
- `users.sub_token` уникален; по нему строится ссылка подписки.
- `accruals.ref` уникален — повторная выдача бонуса не создаёт вторую запись.

## 4. Деньги и тарифы

`payments` объединяет два взгляда:

| Поле | Кто пишет | Смысл |
|---|---|---|
| `kind` | `src/payments.ts` (`recordPayment`) | `manual` / `promo` / `online` — факт выдачи |
| `days`, `note` | оба | на сколько дней и комментарий |
| `amount_rub`, `currency` | `src/plans.ts` (`recordMoneyPayment`) | сумма и валюта |
| `method`, `status`, `external_id` | `/pay`, будущий вебхук | способ, состояние, id провайдера |
| `plan_code` | `/pay` | какой тариф оплачен |
| `actor`, `paid_at` | `/pay` | кто записал и когда |

Онлайн-провайдер не подключён: платные сервисы не добавляются без явного
подтверждения владельца. Схема готова к вебхуку: ему останется писать
`external_id` и проверять уникальность до вставки.

## 5. Индексы

Индексы повторяют реальные запросы, а не «на всякий случай»:

- `users(status)`, `users(sub_token)` — вход по токену и выборки по статусу;
- `servers(status, enabled, country_code, priority)` — сборка подписки;
- `server_checks(server_id, kind)` — стабильность и последние проверки;
- `assignments(server_id)` — нагрузка на узел;
- `import_runs(source_id, ran_at DESC)` — последний прогон источника;
- `payments(user_id, id DESC)` и `payments(status, created_at DESC)` — история
  и сводка;
- `plans(active, sort, id)` — порядок карточки тарифов.

## 6. Бэкап и восстановление

Ежедневно `src/backup.ts` собирает JSON и отправляет документом админу в
Telegram. В дамп входят данные, без которых нельзя восстановить сервис:

```
settings, sources, pools, servers, pool_servers, users,
user_pools, user_sources, assignments, plans, payments,
promos, promo_uses, accruals, daily_claims, referrals,
invites, user_devices, user_squads, sub_versions,
banners, notify_log
```

Сознательно не входят `events`, `fetch_log`, `server_checks`, `import_runs`,
`user_presence`, `bot_state`: это журналы и временное состояние, они бы
раздули файл и не нужны для доступа.

Восстановление:

```bash
node tools/restore-backup.mjs vpn-hub-backup-2026-11-11.json
node tools/restore-backup.mjs vpn-hub-backup-2026-11-11.json --apply
```

Скрипт превращает JSON в SQL (`INSERT OR REPLACE`) и по флагу `--apply`
применяет его к D1. В дампе есть токены подписок и ссылки источников, поэтому
каталог `backups/` в `.gitignore` и файлы нельзя коммитить.

Полный SQL-дамп и схема:

```bash
npm run db:export          # данные + схема
npm run db:export:schema   # только DDL
```

У D1 есть Time Travel: точка восстановления на любой момент за последние
7 дней (бесплатный план).
