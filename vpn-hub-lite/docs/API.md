# API

Два независимых контура:

- **публичный** `/api/v1/*` — только чтение, без секретов, лимит 60 запросов
  в минуту с одного IP;
- **служебный** `/api/checks*` — приём результатов от Xray-агента, общий
  секрет в заголовке `x-check-token`.
- **служебный** `/api/merge/*` — внешние подписки: статус, ручной синк,
  обмен списком узлов и результатами проверки (тот же `x-check-token`).

Машинное описание публичного API: `GET /api/v1/openapi.json` (OpenAPI 3.1).

## Формат ошибок

```json
{ "error": { "code": "rate_limited", "message": "Слишком много запросов: 60 в минуту" } }
```

Коды: `method_not_allowed` (405), `rate_limited` (429), `not_found` (404).

## GET /api/v1/status

Состояние сервиса. Используется страницей `/status` и внешним мониторингом.

```bash
curl -s https://vpn-hub-lite.twistx-launcher.workers.dev/api/v1/status
```

```json
{
  "ok": true,
  "version": "1.0.0",
  "time": "2026-10-23T14:24:13.237Z",
  "db": { "ok": true, "latency_ms": 229 },
  "counts": { "servers": 1292, "alive": 497, "sources": 14, "dead_sources": 0 },
  "last": { "sync_at": "2026-10-23 12:00:28", "check_at": "2026-10-23 14:21:01" },
  "checks_24h": {
    "tunnel": { "ok": 3, "fail": 13 },
    "port": { "ok": 889, "fail": 407 }
  }
}
```

`checks_24h.tunnel` — настоящие проверки через Xray. `checks_24h.port` —
только TCP-коннект; работоспособность VPN он не доказывает.

При недоступной базе — `503` и `ok: false`.

## GET /api/v1/stats

Сводка по опубликованным конфигурациям.

```bash
curl -s "https://vpn-hub-lite.twistx-launcher.workers.dev/api/v1/stats"
```

Поля: `scan` (границы расчёта), `published` (`total`, `tested` — туннель
проверяли, `working` — последняя проверка успешна, `with_latency`,
`avg_latency_ms`), `tunnel_24h`, `countries`, `users_active`, `import_24h`.

Если `scan.truncated` = `true`, база больше выборки в 2000 строк и цифры
неполные — это честный признак, а не ошибка.

## GET /api/v1/sources

Источники **без URL** (в URL лежит ключ подписки):

```json
{
  "sources": [
    { "id": 4, "name": "Public NL", "kind": "public", "status": "alive",
      "last_sync_at": "2026-10-23 12:00:28", "servers": 120, "error": null }
  ]
}
```

## GET /api/v1/servers

Опубликованные VLESS + REALITY серверы.

| Параметр | Тип | По умолчанию | Смысл |
|---|---|---|---|
| `limit` | 1–100 | 30 | размер страницы |
| `offset` | ≥ 0 | 0 | смещение |
| `country` | ISO-код | — | фильтр страны |
| `max_latency` | мс | — | только узлы с задержкой туннеля не выше |

```bash
curl -s "https://vpn-hub-lite.twistx-launcher.workers.dev/api/v1/servers?country=NL&limit=5"
```

```json
{
  "count": 1,
  "next_offset": null,
  "servers": [
    { "id": 20, "name": "Finland, Helsinki", "country": "Finland",
      "city": "Helsinki", "country_code": "FI",
      "latency_ms": 670, "port_latency_ms": 679, "status": "alive",
      "last_check_at": "2026-10-23 14:20:59",
      "verified_at": "2026-10-23 14:36:11",
      "protocol": "vless", "reality": true, "pool": "Беларусь", "checked": true }
  ]
}
```

Что **не** отдаётся: `link`, `host`, `port`, UUID, `pbk`, `sid`, `sni`.
Публичный API никогда не превращается в источник конфигураций.

`latency_ms` — задержка туннельной проверки, `null` если туннель не проверяли.
`port_latency_ms` — TCP-коннект, справочно.

## GET /api/checks/queue

Очередь для агента. Требует заголовок `x-check-token`.

```bash
curl -s -H "x-check-token: $CHECK_TOKEN" \
  "https://vpn-hub-lite.twistx-launcher.workers.dev/api/checks/queue?limit=20"
```

```json
{ "queue": [ { "id": 20, "link": "vless://..." } ] }
```

Сортировка: сначала выданные людям и ни разу не проверенные туннелем.
Только `security=reality`: остальные протоколы агент проверять не умеет.

Ручная проверка одного узла — параметр `id`:

```bash
curl -s -H "x-check-token: $CHECK_TOKEN" \
  "https://vpn-hub-lite.twistx-launcher.workers.dev/api/checks/queue?id=269"
```

В агенте это `CHECK_ID=269 node tools/agent/verify.mjs ./xray`.

## POST /api/checks

Принимает результаты проверок. Требует `x-check-token`.

```bash
curl -s -X POST "https://vpn-hub-lite.twistx-launcher.workers.dev/api/checks" \
  -H "content-type: application/json" -H "x-check-token: $CHECK_TOKEN" \
  -d '{"results":[{"id":20,"ok":true,"latency":670,"error":null}]}'
```

Правила:

- максимум **20** результатов за запрос (бюджет D1 — 50 запросов на вызов);
- лишние отбрасываются, ответ содержит `rejected` и `truncated`;
- `ok: true` → `alive` + задержка в `verified_latency_ms`;
- первый провал → `unknown`, второй подряд → `dead`;
- каждый результат пишется в `server_checks` с `kind='tunnel'`.

```json
{ "updated": 8, "rejected": 0, "dead": 0, "truncated": false }
```

## Отзыв токена подписки

Публичного эндпоинта нет сознательно: токен нельзя перевыпустить по одному
знанию URL. Перевыпуск — через бота (раздел «Моя подписка») или админку,
после чего старый URL перестаёт работать.

## /api/merge/*

Служебные маршруты объединённого списка внешних подписок. Все требуют
заголовок x-check-token. Подробности — в [MERGE.md](MERGE.md).

| Метод | Путь | Назначение |
|---|---|---|
| GET | /api/merge/status | время синка, статусы источников, счётчики |
| POST | /api/merge/sync | принудительная синхронизация |
| GET | /api/merge/pool | {nodes:[{id,link,source,status}]} для агента |
| POST | /api/merge/results | {results:[{id,ok,latencyMs,soft}]} |

Пример:

`ash
TOKEN=8yLEyaPrA5Pw6xtyVODkq8y_eNA3AeKOiASzZafI9Hs
curl -s -H "x-check-token: " \
  https://vpn-hub-lite.twistx-launcher.workers.dev/api/merge/status
`

