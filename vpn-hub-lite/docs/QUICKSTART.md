# Быстрый старт «Апельсинка VPN»

Короткая инструкция по восьми действиям. Подробности — в ссылках внутри
разделов.

## 1. Установка

Нужны Node.js 18+ (лучше 20) и аккаунт Cloudflare без карты.

```bash
cd vpn-hub-lite
npm install
npx wrangler login
npx wrangler d1 create vpn-hub-lite        # скопировать database_id в wrangler.toml
npx wrangler kv namespace create CACHE     # скопировать id в wrangler.toml
npx wrangler d1 migrations apply vpn-hub-lite --remote
npx wrangler deploy
```

Адрес воркера (`https://vpn-hub-lite.<поддомен>.workers.dev`) вписать в
`wrangler.toml` → `PUBLIC_BASE_URL` и задеплоить ещё раз.

## 2. Настройка Cloudflare

Секреты (в репозиторий не попадают):

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put SALT
npx wrangler secret put MERGE_SOURCE_A
npx wrangler secret put MERGE_SOURCE_B
npx wrangler secret put MERGE_SOURCE_C
npx wrangler secret put MERGE_HWID
```

Проверка: `npx wrangler secret list` и `curl https://<воркер>/healthz` → `ok`.

Ограничения бесплатного плана: 5 cron-триггеров на аккаунт, 10 мс CPU на
вызов, 50 подзапросов, суточная квота D1. Текущая раскладка cron — в
`wrangler.toml`; синхронизация источников идёт внутри тика `*/20` с гейтом
30 минут. Подробно — [FREE-LIMITS.md](FREE-LIMITS.md).

## 3. Добавление разрешённого источника

1. Получите письменное разрешение владельца источника на импорт и
   распространение конфигураций. Без разрешения источник не подключается.
2. Проверьте, что ссылка отдаёт данные для выбранного `FETCH_UA` и вашего
   `MERGE_HWID` (панели Remnawave без HWID отвечают заглушкой
   `App not supported`).
3. Запишите ссылку в свободный секрет `MERGE_SOURCE_A/B/C`.
4. `/admin/merge` → «Синхронизировать сейчас».
5. Убедитесь, что источник в статусе «работает» и отдал узлы.

Больше трёх источников: расширить массив `SOURCES` в `src/merge.ts` и
добавить поле в `Env` (`src/types.ts`).

## 4. Ручное обновление

- Панель: `/admin/merge` → «Синхронизировать сейчас».
- API:

```bash
curl -X POST -H "x-check-token: $CHECK_TOKEN" \
  https://<воркер>/api/merge/sync
```

Автоматически — раз в 30 минут (внутри cron `*/20`). Ссылка подписки при
обновлении не меняется.

## 5. Проверка серверов

Проверку делает агент на GitHub Actions (Xray поднимается на каждый узел и
через него идёт реальный HTTP-запрос):

```bash
gh workflow run merge-check.yml
gh run list --workflow=merge-check.yml --limit 3
```

Статус: `/status` и `/admin/merge`. Правила статусов — в [MERGE.md](MERGE.md).
Порт-проверка (TCP) работоспособность VPN не подтверждает, поэтому в рейтинг
идут только туннельные проверки.

## 6. Обновление проекта

```bash
cd vpn-hub-lite
git pull
npm install
npx wrangler d1 migrations apply vpn-hub-lite --remote
npx wrangler deploy
npm run deploy:apelsinka     # зеркало с коротким именем, если используется
```

Перед деплоем полезно: `npm run typecheck` и `npm test`.

## 7. Подключение подписки в INCY

1. Получите у бота ссылку `https://<воркер>/sub/<токен>`.
2. INCY → «+» → импорт из буфера обмена → разрешить VPN-конфигурацию.
3. Для групп с автоподбором добавьте отдельно `/sub/<токен>/groups`.
4. Обновление — автоматически раз в час, вручную — потянуть список вниз.

Что INCY умеет, а что нет — [INCY.md](INCY.md). Подписка не меняет интерфейс
приложения: тема, индикатор и нижняя навигация — это сам клиент.

## 8. Частые ошибки

| Симптом | Причина | Что делать |
|---|---|---|
| `Error 1102` | превышен CPU 10 мс | уменьшить `MAX_KEYS`/`BATCH` в `sync.ts`/`health.ts` |
| `D1_ERROR: no such table` | не применены миграции | `npx wrangler d1 migrations apply vpn-hub-lite --remote` |
| `KV PUT failed: 429` | 1000 записей в сутки | поднять `SUB_CACHE_TTL` до 1800–3600 |
| Источник «ошибка», узлы остались | источник не ответил | ничего: работает прошлая версия |
| Заглушка «App not supported» | панель не признала клиента | проверить `MERGE_HWID` и `FETCH_UA` |
| Пустой список группы | нет проверенных узлов в пуле | `/admin/merge` → синхронизация, затем проверка агентом |
| Бот молчит | не тот транспорт | `BOT_TRANSPORT=polling` для `*.workers.dev` |
| `/api/v1/status` → 503 `db_unavailable` | исчерпана суточная квота D1 | дождаться 00:00 UTC или перевести базу на Turso ([MIGRATION.md](MIGRATION.md)) |

## 9. Тихие часы

Ночью сервис не тратит квоты: проверки узлов, синхронизация источников,
геолокация и уведомления пропускаются, а бэкап и приём сообщений бота
продолжают работать.

По умолчанию тишина с 23:00 до 08:00 по Иркутску (UTC+8). Настройка:

| Переменная | Значение | Смысл |
|---|---|---|
| `QUIET_HOURS` | `23-8` | окно по местному времени; `off` — выключить |
| `QUIET_UTC_OFFSET` | `8` | смещение местного времени от UTC |

Расписания GitHub Actions сдвинуты в дневное окно (09:00–23:00 по Иркутску),
поэтому ночью не запускаются ни проверки, ни обновления. Это видно по cron:
`*/30 1-14 * * *` — это 09:00–23:00 местного.

Проверить, что тишина включена, можно по логам воркера: в тихие часы cron
пишет `тихие часы 23:00–08:00 (UTC+8): <расписание> пропущен`.
