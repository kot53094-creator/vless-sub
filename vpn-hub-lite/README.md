# VPN Hub Lite

Личный хаб на Cloudflare Workers: собирает серверы из источников, выдаёт каждому
человеку **персональную** ссылку-подписку для Happ, регистрирует людей через
Telegram-бота и распределяет их по серверам так, чтобы ноды не переполнялись.

Работает на бесплатном плане Cloudflare: без карты, без сервера, без Docker.

```
Telegram ──webhook──▶ Worker ──▶ D1 (данные)
                        │        KV (кэш подписок)
Happ ──GET /sub/<токен>─┘        cron: sync + health
```

## Что внутри

| Файл | Назначение |
|---|---|
| `src/index.ts` | маршруты: `/sub/<token>`, `/webhook`, `/admin`, `/` |
| `src/sub.ts` | сборка персональной подписки, кэш, fetch_log |
| `src/parser.ts` | разбор vless / vmess / trojan / ss / hysteria2, base64, `subscription-userinfo` |
| `src/balance.ts` | выдача серверов, замена мёртвых, `/rebalance` |
| `src/sync.ts` | cron раз в 6 часов: источники → серверы |
| `src/health.ts` | cron раз в 30 минут: TCP-проверка партии серверов |
| `src/reports.ts` | отчёт админу, напоминания о сроках |
| `src/bot/*` | вебхук, команды пользователя и админа |
| `src/admin.ts` | админка на простом HTML |
| `src/security.ts` | хэши с солью, сравнение за постоянное время, лимиты |
| `migrations/*.sql` | схема D1 и стартовые пулы |
| `test/*.test.ts` | парсер, приватность `paid_private`, балансировка |

## Лимиты бесплатного плана и как они учтены

Проверено по документации Cloudflare (Workers / KV / D1, разделы Limits):

| Ограничение | Значение | Что делает код |
|---|---|---|
| CPU на запрос и на cron | **10 мс** | разбор ограничен 120 ключами и 300 КБ; за прогон 2 источника и 8 серверов |
| Подзапросы (fetch, D1, KV) | **50 на вызов** | батчи по 25, не больше 30 сообщений в цикле, одна выборка на страницу |
| Одновременные соединения | **6** | TCP-проверки идут последовательно |
| Cron-триггеров на аккаунт | **5** | используется 3: sync, health и минутный опрос бота (см. ниже) |
| KV: записи | **1000/сутки** | подписка кэшируется на 600 с, источник — на 6 ч; `fetch_log` пишется не чаще раза в час на человека |
| KV: запись одного ключа | **1/с** | каждый ключ пишется один раз за TTL |
| D1: запросов на вызов | **50** | выборки точечные, вставки — батчами |
| D1: размер базы | **500 МБ** | журнал событий и `fetch_log` маленькие, чистятся вручную |

Если людей станет много, первым упрётся KV: при 100 активных подписках и
обновлении раз в 6 часов это ≈ 400 записей в сутки — запас есть. При 300+
подписках увеличьте `SUB_CACHE_TTL` до 1800.

---

# Установка с нуля

## Шаг 0. Что понадобится

- Аккаунт Cloudflare (бесплатный, **карта не нужна**).
- Telegram-аккаунт и бот от [@BotFather](https://t.me/BotFather).
- Node.js 18+ (лучше 20) — [nodejs.org](https://nodejs.org), кнопка LTS.
- 15–20 минут.

Проверка, что Node есть:

```bash
node -v      # v20.x или выше
npm -v
```

## Шаг 1. Регистрация в Cloudflare

1. Откройте https://dash.cloudflare.com/sign-up — email + пароль, карта не спрашивается.
2. Подтвердите почту.
3. Ничего покупать не нужно: Workers Free включён по умолчанию.

## Шаг 2. Wrangler

```bash
cd vpn-hub-lite
npm install
npx wrangler login
```

Откроется браузер — разрешите доступ. Проверка:

```bash
npx wrangler whoami
```

## Шаг 3. База D1 и кэш KV

```bash
npx wrangler d1 create vpn-hub-lite
```

В выводе будет `database_id = "xxxxxxxx-..."` — скопируйте его в
`wrangler.toml` вместо `REPLACE_WITH_D1_DATABASE_ID`.

```bash
npx wrangler kv namespace create CACHE
```

Скопируйте `id = "..."` в `wrangler.toml` вместо `REPLACE_WITH_KV_NAMESPACE_ID`.

> Если позже захотите preview-окружение, добавьте `preview_id` — для личного
> хаба это не нужно.

## Шаг 4. Секреты

Придумайте значения и выполните по одному (каждая команда спросит значение):

```bash
npx wrangler secret put BOT_TOKEN        # токен из @BotFather
npx wrangler secret put WEBHOOK_SECRET   # любая длинная строка, например: openssl rand -hex 24
npx wrangler secret put ADMIN_TOKEN      # токен входа в /admin
npx wrangler secret put SALT             # соль для хэшей IP/UA, не меняйте потом
```

`ADMIN_TG_ID` уже задан в `wrangler.toml` (8938447065). Если нужен другой —
`npx wrangler secret put ADMIN_TG_ID` (секрет важнее переменной).

Проверка списка:

```bash
npx wrangler secret list
```

## Шаг 5. Схема базы

```bash
npx wrangler d1 migrations apply vpn-hub-lite --remote
```

Спросит подтверждение — `y`. Проверка:

```bash
npx wrangler d1 execute vpn-hub-lite --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

Должны быть: `users, sources, servers, pools, pool_servers, user_pools, assignments, events, fetch_log`.

## Шаг 6. Деплой

```bash
npx wrangler deploy
```

В выводе будет адрес вида `https://vpn-hub-lite.<ваш-поддомен>.workers.dev`.
Впишите его в `wrangler.toml` → `PUBLIC_BASE_URL` (без слэша на конце) и
задеплойте ещё раз:

```bash
npx wrangler deploy
```

Проверка:

```bash
curl https://vpn-hub-lite.<поддомен>.workers.dev/healthz
# ok
```

## Шаг 7. Подключение бота

### Вариант А: опрос (по умолчанию, работает всегда)

Telegram отказывается ставить вебхук на домены `*.workers.dev` — отвечает
`Bad Request: bad webhook: Failed to resolve host`. Это его ограничение, а не
ошибка деплоя (DNS при этом резолвится из любой точки).

Поэтому по умолчанию включён резервный транспорт: раз в минуту Worker сам
забирает обновления через `getUpdates` (третий cron-триггер), а смещение
хранит в таблице `bot_state`. Ничего настраивать не нужно — бот работает
сразу после деплоя.

Проверка: откройте `/admin` → «Проверить обновления». Должно быть
«Новых обновлений: 0» (или больше, если вы только что писали боту).

### Вариант Б: вебхук на своём домене

Если у вас есть домен в Cloudflare, вебхук надёжнее и не тратит cron:

1. В `wrangler.toml` добавьте маршрут:
   ```toml
   routes = [{ pattern = "hub.example.com/*", zone_name = "example.com" }]
   ```
2. Поставьте `PUBLIC_BASE_URL = "https://hub.example.com"` и
   `BOT_TRANSPORT = "webhook"`.
3. Уберите строку `"* * * * *"` из `crons` (опрос больше не нужен).
4. `npx wrangler deploy`, затем в админке нажмите
   **«Подключить бота (setWebhook)»**.

### Ручная установка вебхука (если кнопка недоступна)

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"https://vpn-hub-lite.<поддомен>.workers.dev/webhook","secret_token":"<WEBHOOK_SECRET>"}'
```

Ожидаемый ответ: `{"ok":true,"result":true,"description":"Webhook was set"}`.

Проверка:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

`last_error_message` быть не должно. Если есть `401` — не совпал
`WEBHOOK_SECRET`; если `404` — неверный URL.

## Шаг 8. Первый вход и первая ссылка

1. Откройте бота, отправьте `/start`. Придёт «заявка отправлена админу».
2. Админу (ID из `ADMIN_TG_ID`) придёт сообщение с кнопками
   **Одобрить 7 / Одобрить 30 / Отклонить**. Нажмите «Одобрить 30».
3. Бот пришлёт персональную ссылку `https://.../sub/<токен>` и инструкцию.
4. Серверов пока нет — добавьте ключи: в боте `/addkey`, затем отправьте
   `vless://...` (можно несколько строк) или ссылку на подписку.
5. Подождите до 6 часов (или запустите sync вручную, см. ниже) — серверы
   появятся, а человеку бот напишет «Серверы обновлены».

Проверить, что подписка отдаётся:

```bash
curl -s "https://vpn-hub-lite.<поддомен>.workers.dev/sub/<токен>" | base64 -d
```

Должны быть строки `vless://...` с названиями вида `Европа · VLESS Reality #1`.

## Шаг 9. Happ

1. Установите Happ (Android/iOS/Windows/macOS).
2. «+» → «Импорт по ссылке» (Add subscription).
3. Вставьте ссылку из бота → сохраните.
4. Выберите сервер и включите VPN.

Обновление — автоматически, раз в 6 часов (заголовок
`profile-update-interval`). Вручную — потянуть список вниз.

## Шаг 10. Админка

Откройте `https://<воркер>/admin`, введите `ADMIN_TOKEN`.
Разделы: Пользователи (одобрить/продлить/забанить), Серверы (загрузка в %),
Источники (сроки, трафик, «сделать приватным»), Журнал.

Ссылки и токены в таблицах замаскированы — полностью видны по клику на
«ссылка».

---

# Этапы и команды проверки

| Этап | Что сделано | Проверка |
|---|---|---|
| 1. Каркас, D1, секреты | `wrangler.toml`, миграции, `security.ts` | `npx wrangler d1 migrations apply vpn-hub-lite --remote` и `curl .../healthz` |
| 2. Бот: регистрация и одобрение | `bot/user.ts`, кнопки одобрения | `/start` в боте → заявка админу → «Одобрить» → пришла ссылка |
| 3. `/sub` | `sub.ts`, заглушка для истёкших | `curl .../sub/<токен> \| base64 -d`; `curl .../sub/мусор` → заглушка |
| 4. Источники и sync | `sync.ts`, `parser.ts` | `/addkey` + `wrangler tail` во время sync |
| 5. Health и балансировка | `health.ts`, `balance.ts` | `/servers` в боте; `npx vitest run` |
| 6. Админ-команды и `/admin` | `bot/admin.ts`, `admin.ts` | `/users`, `/pools`, `/report`; вход в `/admin` |
| 7. Отчёты и тесты | `reports.ts`, `test/*` | `npm test` → 20+ тестов |

Команды разработки:

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest
npx wrangler dev      # локально, http://localhost:8787
npm run deploy
npx wrangler tail     # живые логи
```

Локальный запуск требует `.dev.vars` (скопируйте `.dev.vars.example` и
заполните) и локальной базы:

```bash
npx wrangler d1 migrations apply vpn-hub-lite --local
```

---

# Команды бота

**Пользователь:** `/start`, `/key`, `/status`, `/newkey`, `/help`.

**Админ:** `/users`, `/user <tg_id>`, `/approve <tg_id> [дней]`,
`/ban <tg_id>`, `/unban <tg_id>`, `/extend <tg_id> <дней>`,
`/limit <tg_id> <устройств>`, `/pools`, `/grant <tg_id> <пул>`,
`/revoke <tg_id> <пул>`, `/servers`, `/rebalance`, `/addkey`,
`/addsource <имя> <тип> <ссылка>`, `/delsource <id>`, `/private <id>`,
`/report`.

Типы источников: `own_vps`, `trial`, `public`, `bridge_ru`, `cdn_xhttp`,
`paid_private`. `paid_private` всегда приватный — его серверы не попадают
в чужие подписки (есть тест).

---

# Если не работает

| Симптом | Причина | Что делать |
|---|---|---|
| `Error 1102 Worker exceeded resource limits` | превышен CPU (10 мс) | уменьшите `MAX_KEYS`/`BATCH` в `sync.ts` и `health.ts`, проверьте размер источника |
| `D1_ERROR: no such table` | не применены миграции | `wrangler d1 migrations apply vpn-hub-lite --remote` |
| `KV PUT failed: 429` | исчерпаны 1000 записей в сутки | поднимите `SUB_CACHE_TTL` до 1800–3600 |
| Бот молчит | не тот транспорт или бот не запущен | `/admin` → «Проверить обновления»; проверьте `BOT_TRANSPORT` (`polling` для workers.dev) |
| `bad webhook: Failed to resolve host` | Telegram не принимает `*.workers.dev` | оставьте `BOT_TRANSPORT="polling"` или подключите свой домен |
| Ответ на вебхук `403` | заголовок не совпал с `WEBHOOK_SECRET` | перевыпустите секрет и `setWebhook` заново |
| В `/sub` заглушка «Срок истёк» | статус или дата | `/extend <tg_id> 30` |
| В подписке нет серверов | нет назначений или все мертвы | `/servers`, `/rebalance`, `/grant`; проверьте пулы |
| Сайт `1016` / `522` | неверный домен или воркер удалён | `wrangler deploy`, проверьте URL |
| Cron не срабатывает | триггеры появляются только после деплоя | `wrangler deploy`, затем `wrangler tail --format pretty` |

Логи в реальном времени:

```bash
npx wrangler tail --format pretty
```

Полезные запросы к базе:

```bash
npx wrangler d1 execute vpn-hub-lite --remote --command "SELECT id, tg_id, status, expires_at FROM users"
npx wrangler d1 execute vpn-hub-lite --remote --command "SELECT status, COUNT(*) FROM servers GROUP BY status"
npx wrangler d1 execute vpn-hub-lite --remote --command "SELECT id, name, kind, visibility, status FROM sources"
```

---

# Безопасность

- Все секреты — только `wrangler secret`; в репозитории их нет.
- `sub_token` — 32 случайных байта, сравнение за постоянное время.
- IP и User-Agent хранятся как `SHA-256(соль + значение)`, обрезанные до 32 символов.
- Кроме Telegram ID и username персональных данных нет.
- `/sub` ограничен 60 запросами в минуту с адреса, `/admin/login` — 5 попыток за 10 минут.
- Cookie админки: `HttpOnly; Secure; SameSite=Strict`, подписана HMAC от `ADMIN_TOKEN`.
- Полные ключи не логируются: в журнал и админку попадают только маски.
- `paid_private` и `visibility=private` не отдаются никогда — два уровня защиты
  (SQL-фильтр и `isDeliverable`) плюс тест.
