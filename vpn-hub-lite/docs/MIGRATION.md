# Перенос базы и бэкенда

Документ отвечает на вопрос «что делать, если Cloudflare D1, Workers или
Telegram-вебхук перестанут устраивать». Код с самого начала писался так, чтобы
данные и логика не были завязаны на один сервис: доступ к базе идёт через
тонкий слой `src/db.ts`, а не через `env.DB` по всему проекту.

## 1. Что уже переносимо

| Компонент | Текущее состояние | Насколько легко заменить |
|---|---|---|
| База | D1 (SQLite) | **Готово**: Turso/libSQL включается двумя секретами |
| Кэш подписок | Workers KV | необязателен: при сбое читается из базы |
| HTTP/роутинг | Cloudflare Worker (fetch) | нужен адаптер под другой рантайм |
| Cron | Cloudflare Triggers | заменяется внешним планировщиком |
| Telegram | webhook или polling | переносится вместе с доменом |
| Проверки Xray | GitHub Actions / ПК | уже вне Cloudflare |

### Слой базы

`src/db.ts` — единственное место, где выбирается драйвер:

- `one`, `many`, `run`, `batch` — четыре операции, которых хватает всему коду;
- если заданы **оба** секрета `TURSO_URL` и `TURSO_TOKEN`, все операции идут в
  Turso/libSQL;
- иначе — в D1.

Важно: переключаются и чтение, и запись. Раньше в Turso уходили только чтения,
но тогда новые пользователи и платежи оставались бы в D1, а бот читал бы Turso —
данные разошлись бы. Сейчас источник истины всегда один.

`src/turso.ts` говорит по HTTP-протоколу libSQL `/v2/pipeline`: пачка выражений
уходит одним POST, лимит — 50 выражений на запрос.

## 2. Переключение на Turso (резервная база)

### 2.1. Создать базу

```bash
turso auth login
turso db create vpn-hub
turso db show vpn-hub --url          # libsql://...
turso db tokens create vpn-hub       # токен показывается один раз
```

Регион выбирайте из списка, который предлагает CLI/панель (`turso db locations`).
Если API отвечает `invalid location lhr` — региона `lhr` в вашем тарифе нет,
возьмите другой (`fra`, `ams`, `iad` и т. п.). Значение токена сохраните в
менеджер паролей: повторно его не покажут.

### 2.2. Создать схему

```bash
# SQL-дамп схемы без данных (DDL в диалекте SQLite)
npm run db:export:schema
turso db shell vpn-hub < backups/schema.sql
```

Если `wrangler d1 export` недоступен (например, исчерпана суточная квота D1),
схему можно накатить миграциями напрямую:

```bash
for f in migrations/*.sql; do turso db shell vpn-hub < "$f"; done
```

Порядок файлов лексикографический — поэтому миграции нумеруются с ведущими
нулями.

### 2.3. Скопировать данные

```powershell
$env:TURSO_URL="libsql://vpn-hub-....turso.io"
$env:TURSO_TOKEN="..."
npm run db:to-turso
```

Скрипт `tools/export-to-turso.mjs` читает таблицы из D1 через `wrangler` и
заливает строки пачками по 50. Таблицы, которых ещё нет, пропускаются.

### 2.4. Включить на Worker

```bash
npx wrangler secret put TURSO_URL
npx wrangler secret put TURSO_TOKEN
npx wrangler deploy
```

Для зеркала `apelsinka` — те же два секрета и `npm run deploy:apelsinka`.
Секреты не хранятся в репозитории и не попадают в логи.

### 2.5. Проверить

```bash
curl -s https://<домен>/api/v1/status
curl -s -A "Happ/2.9.1" https://<домен>/sub/<токен> -o sub.txt
```

Признаки успеха: `/api/v1/status` отвечает `ok: true`, подписка отдаёт непустой
Base64, в логах `wrangler tail` нет `turso http`.

### 2.6. Миграции после переключения

`wrangler d1 migrations apply` меняет только D1. Пока источник истины — Turso,
каждую новую миграцию применяйте к нему отдельно:

```bash
turso db shell vpn-hub < migrations/0021_....sql
```

Держите D1 в актуальном состоянии, если хотите оставить его горячим резервом.

### 2.7. Откат на D1

1. Снимите секреты: `npx wrangler secret delete TURSO_URL` и `TURSO_TOKEN`.
2. Задеплойте Worker.
3. **Сначала перенесите данные обратно.** Пока был включён Turso, записи шли
   туда. Обратного скрипта в репозитории нет; используйте
   `turso db shell vpn-hub ".dump"` и примените дамп к D1 через
   `wrangler d1 execute --file`. Либо оставьте Turso источником истины и
   откатывайте только приложение.

## 3. Другой хостинг приложения

Код Worker использует `D1Database`, `KVNamespace`, `fetch` и `scheduled`.
Перенос на другой рантайм — это замена этих биндингов, а не «залить архив».

| Площадка | Что даёт | Что придётся сделать |
|---|---|---|
| Deno Deploy | бесплатный тариф, HTTP | заменить `export default { fetch }` на `Deno.serve`, биндинги D1/KV — на Turso и in-memory кэш |
| Vercel Functions | бесплатный тариф, HTTP | Node-адаптер запроса/ответа, Turso вместо D1, внешний cron |
| Render / Fly.io | контейнер | тот же Node-адаптер + постоянный процесс для polling-бота |
| собственный VPS | полный контроль | Caddy/Nginx + Node-адаптер + cron + Turso/Postgres |

Готового адаптера в репозитории нет: это отдельная работа, а не переключатель.
Что уже готово — переносимая база, поэтому переезд сводится к HTTP-обвязке.

### Postgres (Neon, Supabase)

Промт допускает «PostgreSQL или другую обоснованную реляционную БД». Выбрана
D1/Turso (SQLite), потому что:

- бесплатный Postgres без карты нестабилен по лимитам и требует отдельного
  драйвера;
- схема и запросы уже написаны под SQLite;
- Turso даёт тот же SQL и включается без правок кода.

Если понадобится Postgres, менять нужно `src/db.ts` и `src/turso.ts`:
плейсхолдеры `?` → `$1`, `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`,
`datetime('now')` → `now()`. Это заметная, но локальная работа.

## 4. Cron без Cloudflare

Все регулярные задачи вызываются и вручную по HTTP с токеном `CHECK_TOKEN`:

| Задача | Эндпоинт |
|---|---|
| Синхронизация источников | `POST /api/sync` |
| Автопоиск источников | `POST /api/discover` |
| Проверка портов | `POST /api/health` |
| Бэкап в Telegram | `POST /api/backup` |

Внешний планировщик (GitHub Actions, cron на ПК) вызывает их с заголовком
`x-check-token`. Это же спасает, если cron-триггеры Cloudflare недоступны.

## 5. Домен и Telegram

Ссылка подписки — это `PUBLIC_BASE_URL + /sub/<токен>`. Меняется домен —
меняются и ссылки у людей. Чтобы сохранить «одну неизменную ссылку»:

1. привяжите **свой домен к тому же Worker** (Custom Domain), а не разворачивайте
   копию на новом хостинге;
2. обновите `PUBLIC_BASE_URL` в `wrangler.toml` и задеплойте;
3. перерегистрируйте вебхук:

```bash
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<новый-домен>/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

Пока новый домен не подтверждён, старый Worker продолжает работать: DNS
переключается только после проверки.

## 6. Чек-лист переноса

- [ ] Новая база создана, схема применена, данные скопированы.
- [ ] Секреты `TURSO_URL`/`TURSO_TOKEN` заданы, Worker задеплоен.
- [ ] `/api/v1/status` → `ok: true`.
- [ ] `/sub/<токен>` → 200, непустой Base64, заголовок `subscription-userinfo`.
- [ ] Бот отвечает на `/start` и `/status`.
- [ ] `POST /api/backup` присылает JSON в Telegram.
- [ ] Внешний cron или Cloudflare Triggers вызывает задачи.
- [ ] Старый домен/база остаются доступны как резерв минимум неделю.
