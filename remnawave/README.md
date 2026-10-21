# Remnawave Panel для «Апельсинка VPN»

Панель управления пользователями и нодами на базе Xray. Даёт то, чего нет в
Cloudflare Workers: HWID-устройства, группы серверов (squads), лимиты трафика
на пользователя, подписки Remnawave.

## Что нужно

| Требование | Значение |
|---|---|
| Сервер | VPS, Ubuntu 22.04/24.04 или Debian 12 |
| RAM | минимум 2 ГБ, рекомендуется 4 ГБ |
| CPU | 2 ядра |
| Диск | 20 ГБ |
| Домен | обязательно, например `panel.mydomain.ru` (A-запись на IP сервера) |
| Порты | 80 и 443 свободны |

Панель не работает на Cloudflare Workers: ей нужны Docker, PostgreSQL и
постоянный процесс. Текущий бот остаётся на Workers и общается с панелью по API.

## Установка

На сервере, от root:

```bash
scp remnawave/install.sh root@IP:/root/
ssh root@IP
bash /root/install.sh panel.mydomain.ru you@example.com
```

Скрипт поставит Docker и Caddy, сгенерирует секреты, поднимет контейнеры и
выдаст HTTPS-сертификат.

## После установки

1. Открыть `https://panel.mydomain.ru`, создать администратора.
2. Settings → API Tokens → новый токен со scopes `users`, `nodes`, `squads`.
3. На компьютере, в папке `vpn-hub-lite`:

```bash
npx wrangler secret put REMNAWAVE_URL     # https://panel.mydomain.ru
npx wrangler secret put REMNAWAVE_TOKEN   # токен из п.2
npx wrangler deploy
```

4. Проверить связь: в админке бота `/admin/squads` — появятся группы.
5. Включить группы: `/admin/bonuses` → «Группы (Bypass)».

## Как это связано с ботом

- `src/remnawave.ts` — клиент панели. Пока `REMNAWAVE_URL` пустой, модуль
  работает как заглушка: начисления идут в нашу D1, бот не падает.
- После привязки: продление срока и трафика зеркалируется в панель, а группы
  `Default`/`Bypass` выдаются через `activeInternalSquads`.
- Наши подписки (`/sub/<token>`) продолжают работать независимо — панель
  добавляет управление устройствами по HWID и отдельные лимиты.

## Обслуживание

```bash
cd /opt/remnawave
docker compose ps          # состояние
docker compose logs -f     # логи
docker compose pull && docker compose up -d   # обновление
```

Бэкап базы:

```bash
docker exec remnawave-db pg_dump -U postgres remnawave > /root/remnawave-$(date +%F).sql
```
