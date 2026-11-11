# Эксплуатация

## 1. Локальный запуск

```bash
npm install
npx wrangler d1 migrations apply vpn-hub-lite --local
npx wrangler dev
```

Секреты для локальной разработки кладутся в `.dev.vars` (в git не попадает):

```
BOT_TOKEN=...
ADMIN_TOKEN=...
SALT=...
WEBHOOK_SECRET=...
CHECK_TOKEN=...
```

Проверки перед коммитом:

```bash
npm run typecheck
npm test
```

## 2. Развёртывание

```bash
npx wrangler d1 migrations apply vpn-hub-lite --remote
npx wrangler deploy
```

Секреты (один раз или при ротации):

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put SALT
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put CHECK_TOKEN
```

После деплоя проверить:

```bash
curl -s https://vpn-hub-lite.twistx-launcher.workers.dev/api/v1/status
curl -s https://vpn-hub-lite.twistx-launcher.workers.dev/healthz
```

## 3. Агент проверки туннеля

Worker не может запустить Xray. Агент запускается отдельно и присылает
результаты на `POST /api/checks`.

### 3.1 Локально (Windows / macOS / Linux)

```powershell
# 1. Скачать Xray-core
curl.exe -sL -o "$env:TEMP\xray.zip" `
  https://github.com/XTLS/Xray-core/releases/latest/download/Xray-windows-64.zip
Expand-Archive "$env:TEMP\xray.zip" -DestinationPath "$env:TEMP\vpncheck" -Force

# 2. Переменные окружения
$env:BASE_URL='https://vpn-hub-lite.twistx-launcher.workers.dev'
$env:CHECK_TOKEN='<секрет CHECK_TOKEN>'
$env:QUEUE_LIMIT='10'      # сколько узлов проверить за прогон
$env:CURL_TIMEOUT='6'      # таймаут запроса через туннель, секунды
$env:XRAY_START_MS='1500'  # пауза на старт Xray

# 3. Прогон
node tools/agent/verify.mjs "$env:TEMP\vpncheck\xray.exe"
```

На Linux/macOS вместо `xray.exe` передаётся путь к `xray` и скачивается
`Xray-linux-64.zip` или `Xray-macos-64.zip`.

### 3.2 GitHub Actions

Файл `.github/workflows/verify.yml` в репозиторий **не загружен**: у текущего
токена GitHub нет области `workflow`, а выдать её может только владелец
аккаунта в браузере.

Чтобы включить:

1. GitHub → репозиторий → **Add file → Create new file**;
2. имя `.github/workflows/verify.yml`;
3. содержимое — блок ниже;
4. **Commit changes**;
5. в Settings → Secrets and variables → Actions должны быть переменная
   `BASE_URL` и секрет `CHECK_TOKEN`.

```yaml
name: verify-reality
on:
  schedule:
    - cron: "0 */6 * * *"
  workflow_dispatch:
concurrency:
  group: verify-reality
  cancel-in-progress: false
jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
      - name: Скачать Xray-core
        run: |
          curl -fsSL -o xray.zip \
            https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip
          mkdir -p xray
          unzip -oq xray.zip -d xray
          chmod +x xray/xray
          ./xray/xray version
      - name: Проверить очередь
        env:
          BASE_URL: ${{ vars.BASE_URL }}
          CHECK_TOKEN: ${{ secrets.CHECK_TOKEN }}
          QUEUE_LIMIT: "40"
        run: node tools/agent/verify.mjs ./xray/xray
```

Агент отправляет результаты пачками по 20 — это ограничение Worker, не GitHub.

## 4. Резервное копирование

Два независимых механизма.

**Ежедневный JSON в Telegram.** Крон собирает дамп внутри Worker и присылает
документ админу — это хранилище не зависит от Cloudflare:

```bash
curl -s -X POST https://vpn-hub-lite.twistx-launcher.workers.dev/api/backup \
  -H "x-check-token: $CHECK_TOKEN"
```

В дамп входят пользователи, серверы, источники, назначения, тарифы, платежи,
промокоды, начисления, устройства и версии подписок. Журналы (`events`,
`server_checks`, `import_runs`, `fetch_log`) не входят — они не нужны для
восстановления доступа.

**SQL-дамп по требованию** (полная копия, включая служебные таблицы):

```bash
npm run db:export          # backups/vpn-hub-export.sql
npm run db:export:schema   # backups/schema.sql — только DDL
```

Каталог `backups/` в `.gitignore`: в файлах есть токены подписок и ссылки
источников.

### Восстановление из JSON

```bash
node tools/restore-backup.mjs vpn-hub-backup-2026-11-11.json
node tools/restore-backup.mjs vpn-hub-backup-2026-11-11.json --apply
```

Первая команда только собирает SQL (`backups/restore-<дата>.sql`), вторая —
сразу применяет его к D1. Переменные: `D1_NAME` (по умолчанию `vpn-hub-lite`),
`RESTORE_OUT` (путь к SQL). Скрипт использует `INSERT OR REPLACE` и не удаляет
строки, которых не было в дампе; лучше восстанавливать в пустую базу.

### Восстановление из SQL в новую базу

```bash
npx wrangler d1 create vpn-hub-lite-restore
npx wrangler d1 execute vpn-hub-lite-restore --remote --file backups/vpn-hub-export.sql
```

Дополнительно у D1 есть Time Travel: точка восстановления на любой момент за
последние 7 дней (бесплатный план), доступна в панели Cloudflare.

### Резервная база Turso

Если D1 упирается в суточную квоту, включается Turso/libSQL:

```bash
npx wrangler secret put TURSO_URL
npx wrangler secret put TURSO_TOKEN
npx wrangler deploy
```

При заданных обоих секретах **и чтение, и запись** идут в Turso. Подробный
порядок: создание базы, схема, перенос данных, миграции и откат — в
[MIGRATION.md](MIGRATION.md).

## 5. Регламентные операции

| Что | Как | Периодичность |
|---|---|---|
| Синхронизация источников | cron `0 */6 * * *` или кнопка «Скачать сейчас» | 6 часов |
| Проверка портов | cron `*/20 * * * *` | 20 минут |
| Проверка туннеля | агент `.github/workflows/verify.yml` | 30 минут |
| Закрытие просроченных | cron + кнопка «Закрыть просроченные» | 20 минут |
| Бэкап в Telegram | cron или `POST /api/backup` | раз в сутки |
| Чистка `events` | вручную SQL | по мере роста |
| SQL-дамп базы | `npm run db:export` | раз в неделю |
| Проверка восстановления | `tools/restore-backup.mjs` в тестовую базу | раз в месяц |

## 6. Админ-панель

`/admin`, вход по `ADMIN_TOKEN`.

| Раздел | Что делает |
|---|---|
| Дашборд | сводка, графики, состояние |
| Пользователи | статусы, сроки, блокировки |
| Серверы | фильтры, приоритет, вкл/выкл, тариф, проверки |
| Источники | добавление, синхронизация, предпросмотр, выдача людям, слоты |
| **Импорт** | последний прогон по каждому источнику: строки, разобрано, в выдачу, причины отказа |
| Подписки | срок, тариф, отзыв доступа, ссылка на версии |
| **Версии подписок** | история состава и откат на предыдущую версию |
| Бонусы, промокоды, начисления | реферальная механика |
| Баннеры, группы | оформление и пулы |
| События | журнал действий |

Действия, меняющие данные, идут через `POST /admin/action` с CSRF-токеном.

## 7. Пользовательский путь

1. `/start` в боте → заявка со статусом `pending`.
2. Админ одобряет (бот или админка) → `active`.
3. Бот выдаёт ссылку `https://.../sub/<токен>`.
4. Happ импортирует подписку, получает имена вида «🇫🇮 Finland, Helsinki · 1 · 42 мс».
5. Устройства регистрируются автоматически; лишние отвязываются в боте.
6. Перевыпуск ссылки — в боте, старый URL сразу перестаёт работать.

## 8. Диагностика

| Симптом | Причина | Что делать |
|---|---|---|
| Подписка пустая, в имени «Серверы временно недоступны» | нет выданных серверов или все отфильтрованы | проверить `/admin/imports`, затем «Добрать серверы всем» |
| Happ показывает «безлимит» | `total=0` в `subscription-userinfo` | проверить `traffic_gb` пользователя |
| Источник `dead`, «HTML-страница вместо подписки» | вместо подписки отдалась страница | проверить URL вручную, нужен `FETCH_UA` как у клиента |
| «нет ключей: base64 (не разобрался)» | тело не декодируется | посмотреть «Предпросмотр» источника |
| В импорте много «security не reality» | источник отдаёт TLS/WS | это ожидаемо: в выдачу идут только REALITY |
| Ошибка 1102 | превышен CPU 10 мс | уменьшить `MAX_KEYS`, число источников за прогон |
| Ошибка 1027 | суточный лимит запросов | поднять `SUB_CACHE_TTL`, дождаться 00:00 UTC |
| D1: `code: 7500` | исчерпан суточный лимит строк чтения | `/sub` живёт на KV; админка и экспорт — после 00:00 UTC или включить Turso |
| D1: ошибки записи | исчерпан лимит строк записи | снизить частоту проверок, почистить `events`/`import_runs` |
| Turso: `invalid location` | регион недоступен на тарифе | выбрать другой регион в `turso db locations` |
| Turso: `turso http 401` | неверный или отозванный токен | создать новый `turso db tokens create` |
| Агент: `xray не запустился` | неверный путь к бинарнику | передать полный путь к `xray`/`xray.exe` |
| Агент: все `fail` | узлы недоступны из вашей сети | это реальный результат; часть узлов в РФ не работает |

## 9. Что проверить после изменений

1. `npm run typecheck` — без ошибок.
2. `npm test` — все тесты зелёные.
3. `npx wrangler d1 migrations apply ... --remote`.
4. `npx wrangler deploy` и `npm run deploy:apelsinka` (если зеркало включено).
5. `GET /api/v1/status` → `ok: true`.
6. `GET /api/v1/servers` → нет полей `link`, `host`, `port`.
7. `GET /sub/<свой токен>` → Base64, заголовок `subscription-userinfo` с ненулевым `expire`.
8. `POST /api/backup` → документ приходит в Telegram.
9. `node tools/restore-backup.mjs <дамп>` → SQL собирается без ошибок.
