# KavkazVPN: как забрать ключи в свою базу

## Зачем

Подписка `https://sub.kavkazvpn.ru/2LEJyk6YpNj5-XAM` не должна быть
единственной точкой отказа. Её ключи лежат в D1 как приватный источник
`Kavkaz · живой ключ 02.11` (`visibility='private'`, `tier='personal'`):
их видит только владелец, а подписка собирается из его же базы.

## Почему обычное скачивание не работает

1. `sub.kavkazvpn.ru` → `31.31.197.122`. TCP открывается, но TLS-handshake
   висит; через Cloudflare приходит `HTTP 525`. Это поломка на стороне
   провайдера, а не блокировка.
2. За тем же контентом стоит `api.kavkazvpn.ru` (`45.43.92.32`). nginx
   выбирает сайт по заголовку `Host`, поэтому запрос к api-адресу с
   `Host: sub.kavkazvpn.ru` отдаёт подписку.
3. Без заголовка `x-hwid` сервер возвращает заглушку «Приложение не
   поддерживается» — один фиктивный `vless://`. С `x-hwid` приходит полный
   конфиг в формате sing-box (не base64-ссылки).
4. Подписка ограничена числом устройств: каждый новый `x-hwid` занимает
   слот. Поэтому HWID постоянный (`a1b2c3d4e5f6`), а не случайный.

## Обновить ключи

```bash
# 1. Скачать живую подписку (JSON sing-box)
python tools/fetch_kavkaz.py 2LEJyk6YpNj5-XAM

# 2. Превратить outbounds в обычные vless:// ссылки
python tools/kavkaz_to_links.py configs/kavkaz-live.json configs/kavkaz-live-links.txt

# 3. Залить в D1 как приватный источник
python scripts/import_kavkaz_live.py configs/kavkaz-live-links.txt
npx wrangler d1 execute vpn-hub-lite --remote --file "$TEMP/kavkaz_live.sql"
```

После импорта узлы попадают в очередь проверки (`status='unknown'`).
В подписку они пробьются только после настоящей проверки: `alive`,
`verified_latency_ms > 0`, Telegram открывается.

## Если провайдер снова оживёт

Источник можно перевести на прямой URL:

```sql
UPDATE sources
   SET url_or_link = 'https://sub.kavkazvpn.ru/2LEJyk6YpNj5-XAM',
       last_sync_at = NULL
 WHERE name = 'Kavkaz · живой ключ 02.11';
```

Но синк в Worker не умеет подставлять `Host` и `x-hwid`, поэтому рабочий
способ — локальный `fetch_kavkaz.py` (можно запускать по расписанию).
