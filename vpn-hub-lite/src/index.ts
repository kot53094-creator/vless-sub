/** Точка входа Worker: подписки, вебхук бота, админка, cron. */

import { handleAdmin, isAuthed } from "./admin";
import { statsPage } from "./admin_stats";
import { cmdMarkDead } from "./bot/manual";
import { keysPage } from "./keys_page";
import { probePage, probeState } from "./probe_page";
import { clientIp } from "./security";
import { handleApiV1 } from "./api_v1";
import { handleChecks, handleQueue } from "./checks_api";
import { handleImport, handleStats } from "./import_api";
import { handleUpdate, type TgUpdate } from "./bot";
import { fillGeo } from "./geo";
import { premiumLanding } from "./landing";
import { aiDiagnose, handleAiCommand } from "./ai";
import { runBackup } from "./backup";
import { runDiscovery } from "./discover";
import { runHealth } from "./health";
import { GEOSITE_DAT_BASE64 } from "./geosite_data";
import { expireSubscriptions } from "./maintenance";
import { runNotifications } from "./notify";
import { runPoll, watchWebhook } from "./polling";
import { checkTokenOk, envStr, timingSafeEqual } from "./security";
import { statusPage } from "./status_page";
import { handleSubscription, invalidatePool, type SubMode } from "./sub";
import { run } from "./db";
import { countWhitelist, tagWhitelist } from "./whitelist";
import { loadWhitelistPool } from "./sub";
import { loadPool } from "./sub";
import { runSync } from "./sync";
import { sendToAdmin, tgRaw } from "./bot/telegram";
import type { Env } from "./types";
import { BRAND } from "./brand";

const SYNC_CRON = "0 */6 * * *";
const HEALTH_CRON = "*/20 * * * *";
const BACKUP_CRON = "0 4 * * *";
const DISCOVER_CRON = "10 0 * * *";

function landing(env: Env): Response {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BRAND}</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e8ecf3;
font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.card{max-width:520px;padding:26px;border:1px solid #262b36;border-radius:16px;background:#171a21}
h1{margin:0 0 6px;font-size:22px}p{color:#8b95a7;margin:0 0 12px}
code{background:#12151b;border:1px solid #262b36;border-radius:6px;padding:1px 5px;font-size:13px}
a{color:#ff8a3d}
</style></head><body><div class="card">
<h1>${BRAND}</h1>
<p>Персональные подписки для Happ. Ссылку выдаёт Telegram-бот после одобрения.</p>
<p>Пользователям: откройте бота и отправьте <code>/start</code>.</p>
<p>Админ: <a href="/admin">панель управления</a> · <a href="/status">состояние сервиса</a> · <a href="/api/v1/status">API</a></p>
<p style="font-size:12px">${env.PUBLIC_BASE_URL}</p>
</div></body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/healthz") return new Response("ok");

    // Публичный read-only API и страница состояния.
    if (path === "/api/v1" || path.startsWith("/api/v1/")) {
      return await handleApiV1(request, env);
    }
    if (path === "/status" || path === "/status/") return await statusPage(env);

    // Свой IP, каким его видит Cloudflare. Нужен агенту проверок: запрос идёт
    // через туннель, поэтому здесь оказывается выходной IP узла. По этой карте
    // потом определяется, что у человека реально включён VPN.
    if (path === "/api/ip") {
      return Response.json(
        { ip: clientIp(request) },
        { headers: { "cache-control": "no-store" } },
      );
    }

    // Живая страница «включён ли VPN» по токену подписки.
    if (path.startsWith("/p/")) {
      const rest = decodeURIComponent(path.slice("/p/".length));
      if (rest.endsWith("/state")) {
        return await probeState(env, rest.slice(0, -"/state".length), request);
      }
      return await probePage(env, rest.replace(/\/$/, ""), request);
    }

    // Результаты настоящих проверок от агента на GitHub Actions.
    if (path === "/api/checks" && request.method === "POST") {
      return await handleChecks(env, request);
    }
    if (path === "/api/checks/queue") {
      return await handleQueue(env, request);
    }

    // Ручной прогон геолокации: иначе ждать ближайшего */20 и не видеть,
    // почему у узла нет страны.
    if (path === "/api/geo" && request.method === "POST") {
          if (!(await checkTokenOk(env, request))) {
        return new Response("forbidden", { status: 403 });
      }
      return Response.json({ updated: await fillGeo(env, 40) });
    }

    // Приём ключей и статистика для локального скрипта обслуживания.
    if (path === "/api/import" && request.method === "POST") {
      return await handleImport(env, request);
    }
    if (path === "/api/stats") {
      return await handleStats(env, request);
    }

    // Диагностика пула: что реально видит сборка подписки.
    if (path === "/api/pool/debug") {
      if (!(await checkTokenOk(env, request))) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        const rows = await loadPool(env, false, false, false);
        const white = await loadWhitelistPool(env, false);
        const direct = (await env.CACHE.get("direct:links")) ?? "";
        return Response.json({
          directLines: direct.split(/\r?\n/).filter(Boolean).length,
          whiteCount: white.length,
          count: rows.length,
          first: rows.slice(0, 3).map((row) => ({
            host: row.host,
            port: row.port,
            cc: row.country_code,
            ping: row.verified_latency_ms,
            at: row.verified_at,
          })),
          stamp: await env.CACHE.get("pool:stamp"),
        });
      } catch (error) {
        return Response.json(
          {
            error: String(error),
            stack: error instanceof Error ? (error.stack ?? "").slice(0, 900) : "",
          },
          { status: 500 },
        );
      }
    }

    // Запись готового пула в KV под админ-токеном.
    //
    // Wrangler с этой машины не умеет писать в удалённый KV (spawn EPERM),
    // а пересобрать подписку через базу нельзя, когда исчерпана суточная
    // квота D1. Поэтому узлы, проверенные туннелем локально, приходят сюда
    // и ложатся в тот же KV, откуда их читает сборка подписки.
    if (path === "/api/pool/set" && request.method === "POST") {
      if (!(await checkTokenOk(env, request))) {
        return new Response("forbidden", { status: 403 });
      }
      const allowed = new Set([
        "pool:verified:v19",
        "pool:whitelist:v1",
        "pool:stamp",
        "pool:rescue:v1",
        "pool:manual",
        "direct:links",
      ]);
      try {
        const body = (await request.json()) as {
          key?: string;
          value?: unknown;
          ttl?: number;
        };
        const key = String(body.key ?? "");
        if (!allowed.has(key)) {
          return Response.json({ error: "key not allowed" }, { status: 400 });
        }
        const value =
          typeof body.value === "string" ? body.value : JSON.stringify(body.value);
        const ttl = Number(body.ttl ?? 43200) || 43200;
        await env.CACHE.put(key, value, { expirationTtl: ttl });
        return Response.json({ ok: true, key, bytes: value.length, ttl });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    }

    // Разметка пула «Белые списки» без полного sync.
    if (path === "/api/whitelist" && request.method === "POST") {
      if (!(await checkTokenOk(env, request))) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        const tagged = await tagWhitelist(env);
        await invalidatePool(env);
        const total = await countWhitelist(env);
        return Response.json({ tagged, total });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    }

    // Массовая пометка по странам: «эти не работают — убери у всех».
    if (path === "/api/dead-country" && request.method === "POST") {
      if (!(await checkTokenOk(env, request))) {
        return new Response("forbidden", { status: 403 });
      }
      let names: string[] = [];
      try {
        const body = (await request.json()) as { names?: unknown };
        names = Array.isArray(body.names)
          ? body.names.map((item) => String(item).trim()).filter(Boolean)
          : [];
      } catch {
        return new Response("bad request", { status: 400 });
      }
      if (names.length === 0) return new Response("bad request", { status: 400 });

      let marked = 0;
      for (const name of names) {
        const result = await run(
          env,
          "UPDATE servers SET status = 'dead', ru_dead_at = datetime('now'), last_check_at = datetime('now') WHERE enabled = 1 AND (country_code = ? OR country_name LIKE ?)",
          name.toUpperCase(),
          `%${name}%`,
        );
        marked += result.meta?.changes ?? 0;
      }
      await invalidatePool(env);
      return Response.json({ names, marked });
    }

    // Ручная пометка узла мёртвым (то же, что /dead в боте).
    if (path === "/api/dead" && request.method === "POST") {
      if (!(await checkTokenOk(env, request))) {
        return new Response("forbidden", { status: 403 });
      }
      const query = new URL(request.url).searchParams.get("query") ?? "";
      return Response.json({ reply: await cmdMarkDead(env, query) });
    }

    // Проверка, что уведомления о замене доходят: отправляет образец сводки.
    if (path === "/api/health-test" && request.method === "POST") {
      if (!(await checkTokenOk(env, request))) {
        return new Response("forbidden", { status: 403 });
      }
      await sendToAdmin(
        env,
        [
          "🔁 Замена узлов (пример)",
          "проверено: 12 · упало: 2 · заменено: 2 узлов · люди: 3",
          "🇩🇪 Германия → 🇫🇮 Финляндия · 2 чел.",
          "🇳🇱 Нидерланды → 🇸🇪 Швеция · 1 чел.",
          "добрано узлов: 4",
        ].join("\n"),
      );
      return Response.json({ ok: true });
    }

    // Ручной тик проверки здоровья: не ждать :20, а прогнать сейчас.
    if (path === "/api/health-run" && request.method === "POST") {
      if (!(await checkTokenOk(env, request))) {
        return new Response("forbidden", { status: 403 });
      }
      return Response.json(await runHealth(env));
    }

    // Ручной прогон автопоиска источников (крон делает то же в 03:30 UTC).
    if (path === "/api/discover" && request.method === "POST") {
          if (!(await checkTokenOk(env, request))) {
        return new Response("forbidden", { status: 403 });
      }
      return Response.json(await runDiscovery(env));
    }

    // Ручной бэкап базы: и проверка, что документ доходит до Telegram.
    if (path === "/api/backup" && request.method === "POST") {
          if (!(await checkTokenOk(env, request))) {
        return new Response("forbidden", { status: 403 });
      }
      return Response.json(await runBackup(env, true));
    }

    // Диагностика ИИ: отвечает ли биндинг Workers AI.
    if (path === "/api/ai" && request.method === "GET") {
          if (!(await checkTokenOk(env, request))) {
        return new Response("forbidden", { status: 403 });
      }
      return Response.json(await aiDiagnose(env));
    }

    // ИИ-админ для скриптов и мониторинга: тот же обработчик, что в боте.
    // Нужен, чтобы «убери упавшие» можно было вызывать из cron или терминала.
    if (path === "/api/ai" && request.method === "POST") {
          if (!(await checkTokenOk(env, request))) {
        return new Response("forbidden", { status: 403 });
      }
      let text = "";
      try {
        text = String(((await request.json()) as { text?: unknown }).text ?? "");
      } catch {
        return new Response("bad request", { status: 400 });
      }
      return Response.json({ reply: await handleAiCommand(env, "api", text) });
    }

    // Принудительная пересборка пула: скрипт обслуживания просит её после
    // прогона проверок, чтобы подписка обновилась сразу, а не через час TTL.
    if (path === "/api/pool/refresh" && request.method === "POST") {
          if (!(await checkTokenOk(env, request))) {
        return new Response("forbidden", { status: 403 });
      }
      await invalidatePool(env);
      await Promise.all([
        env.CACHE.delete("snapshot:default"),
        env.CACHE.delete("snapshot:reality"),
        env.CACHE.delete("snapshot:working"),
      ]);
      return Response.json({ ok: true });
    }

    // Геофайлы для маршрутизации Happ.
    //
    // Отдаём свои нарезки вместо полных сборок: geoip.dat весит 16 МБ,
    // geosite.dat — 11 МБ, и Happ не успевает скачать второй за три минуты,
    // после чего ядро вообще не запускается с ошибкой про секцию ADS. Здесь
    // только Россия в geoip (~400 КБ) и нужные секции в geosite (~25 КБ).
    //
    // Префикс v2 — вынужденный: Happ кеширует геофайл по адресу, и старая
    // версия без секции ADS продолжала бы подхватываться. Новый путь — новый
    // файл с нуля.
    // geosite отдаём из бандла: 25 КБ, зато без KV и без задержки
    // распространения — первый же запрос получает файл, а не 404.
    if (path === "/geo/g4/geosite.dat") {
      const binary = atob(GEOSITE_DAT_BASE64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Response(bytes, {
        headers: {
          "content-type": "application/octet-stream",
          "cache-control": "public, max-age=604800",
        },
      });
    }

    if (path === "/geo/v3/geoip.dat" || path === "/geo/v3/geosite.dat") {
      const key = path.endsWith("geoip.dat") ? "geo:geoip:v3" : "geo:geosite:v3";
      const data = await env.CACHE.get(key, "arrayBuffer");
      if (!data) return new Response("not found", { status: 404 });
      return new Response(data, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(data.byteLength),
          // Неделя: файлы меняются вместе с обновлением сборки правил.
          "cache-control": "public, max-age=604800",
        },
      });
    }

    // Персональная витрина ключей: тот же токен, что и у подписки.
    if (path.startsWith("/keys/")) {
      return await keysPage(env, decodeURIComponent(path.slice("/keys/".length)));
    }

    if (path.startsWith("/sub/")) {
      const rest = decodeURIComponent(path.slice("/sub/".length)).replace(/\/$/, "");
      // Поддерживаем /sub/<токен> и /sub/<токен>/<режим>.
      const [token, rawMode = ""] = rest.split("/");
      const MODES: Record<string, SubMode> = {
        reality: "reality",
        "reality-working": "working",
        "reality-best": "best",
        "reality-stable": "stable",
        "reality-low-latency": "low-latency",
        "reality-untested": "untested",
        working: "working",
        best: "best",
        stable: "stable",
        untested: "untested",
        "low-latency": "low-latency",
        byedpi: "byedpi",
        // «Автоматический выбор»: JSON-конфиг Xray с балансировщиком.
        auto: "auto",
        json: "auto",
        "auto-json": "auto",
        // Резервный список ссылок: для клиентов, которые не понимают JSON.
        sb: "sb",
        singbox: "sb",
        list: "plain",
        txt: "plain",
        base64: "plain",
      };
      return await handleSubscription(env, token, request, MODES[rawMode] ?? "default");
    }

    if (path === "/webhook" && request.method === "POST") {
      const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
      if (!envStr(env.WEBHOOK_SECRET) || !timingSafeEqual(provided, envStr(env.WEBHOOK_SECRET))) {
        return new Response("forbidden", { status: 403 });
      }
      let update: TgUpdate;
      try {
        update = (await request.json()) as TgUpdate;
      } catch {
        return new Response("bad request", { status: 400 });
      }
      // Отвечаем Telegram сразу, обработку делаем после ответа.
      ctx.waitUntil(
        handleUpdate(env, update).catch(async (error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error("bot update failed", message);
          // Исчерпанная квота D1 не должна оставлять человека в тишине:
          // отправка сообщения в Telegram базу не трогает.
          if (!/D1|database|row read|7500|SQLITE|no such table/i.test(message)) return;
          const chatId =
            update.message?.chat?.id ??
            update.callback_query?.message?.chat?.id ??
            update.callback_query?.from?.id;
          if (!chatId) return;
          const { sendMessage } = await import("./bot/telegram");
          await sendMessage(
            env,
            chatId,
            "⚙️ <b>Технические работы</b>\nБаза перегружена — отвечу, как только она освободится. Подписка продолжает работать: серверы отдаются из резерва.",
          ).catch(() => false);
        }),
      );
      return new Response("ok");
    }

    // Публичная диагностика бота: только факт доставки, без URL вебхука и
    // токенов. По ней видно, живы ли вебхук и очередь Telegram.
    if (path === "/api/tg" && request.method === "GET") {
      const info = await tgRaw<{
        url?: string;
        pending_update_count?: number;
        last_error_message?: string;
      }>(env, "getWebhookInfo");
      return Response.json({
        ok: info.ok,
        urlSet: Boolean(info.result?.url),
        pending: Number(info.result?.pending_update_count ?? 0),
        error: info.result?.last_error_message ?? null,
        note: info.description ?? null,
      });
    }

    // Графики живут отдельным модулем: страница читает только агрегаты,
    // поэтому её можно открывать сколько угодно без нагрузки на список.
    if (path === "/admin/stats") {
      if (!(await isAuthed(request, env))) {
        return new Response(null, { status: 303, headers: { location: "/admin/login" } });
      }
      return await statsPage(env);
    }

    if (path === "/admin" || path.startsWith("/admin/")) {
      return await handleAdmin(request, env);
    }

    if (path === "/") return premiumLanding(env);

    return new Response("Не найдено", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === SYNC_CRON) {
      ctx.waitUntil(
        (async () => {
          try {
            const result = await runSync(env);
            // Отчёт в Telegram: иначе о том, что источники отработали,
            // видно только по цифрам в /status.
            const errors = result.errors.slice(0, 3).join("; ");
            await sendToAdmin(
              env,
              [
                "📥 Источники обновлены",
                `источников: ${result.sources} · узлов: ${result.servers}`,
                errors ? `ошибки: ${errors}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            );
          } catch (error) {
            console.error("sync failed", error instanceof Error ? error.message : error);
          }
        })(),
      );
      return;
    }
    if (event.cron === DISCOVER_CRON) {
      // Утренний сбор пула: 00:10 UTC = 08:10 по Иркутску.
      // Квота D1 обнуляется в 00:00 UTC, десять минут — запас на границу
      // суток. Порядок: новые источники → импорт → пересборка пула.
      ctx.waitUntil(
        (async () => {
          try {
            await runDiscovery(env);
            await runSync(env);
            await invalidatePool(env);
          } catch (error) {
            console.error(
              "morning rebuild failed",
              error instanceof Error ? error.message : error,
            );
          }
        })(),
      );
      return;
    }
    if (event.cron === BACKUP_CRON) {
      ctx.waitUntil(
        runBackup(env).catch((error) => {
          console.error("backup failed", error instanceof Error ? error.message : error);
        }),
      );
      return;
    }
    if (event.cron === HEALTH_CRON) {
      ctx.waitUntil(
        (async () => {
          try {
            await runHealth(env);
            // Автоспасание пула. Обычная сборка источников идёт раз в 6 часов,
            // и если источники выдохлись сразу после неё, подписка до вечера
            // живёт на резервном снимке. Здесь просадка замечается в том же
            // тике: не чаще раза в час запускаем sync заново.
            const pool = await env.CACHE.get<{ verified: number; threshold: number }>(
              "pool:health",
              "json",
            );
            if (pool && pool.verified < pool.threshold) {
              if (!(await env.CACHE.get("pool:rescue"))) {
                await env.CACHE.put("pool:rescue", "1", { expirationTtl: 3600 });
                await runSync(env);
              }
            }
          } catch (error) {
            console.error("health failed", error instanceof Error ? error.message : error);
          }
        })(),
      );
      // Уведомления о сроке + снятие истёкших групп живут в этом же тике.
      // Геолокация новых серверов — по 40 за тик, чтобы не жечь лимит D1.
      ctx.waitUntil(
        fillGeo(env).catch((error) => {
          console.error("geo failed", error instanceof Error ? error.message : error);
        }),
      );
      // Просроченные подписки переводим в expired до рассылки уведомлений.
      ctx.waitUntil(
        expireSubscriptions(env).catch((error) => {
          console.error("expire failed", error instanceof Error ? error.message : error);
        }),
      );
      ctx.waitUntil(
        runNotifications(env).catch((error) => {
          console.error("notify failed", error instanceof Error ? error.message : error);
        }),
      );
      return;
    }
    // Раз в минуту: либо забираем обновления сами (резервный транспорт),
    // либо проверяем, что вебхук жив, и падаем в опрос при ошибках доставки.
    if ((env.BOT_TRANSPORT ?? "webhook") === "polling") {
      ctx.waitUntil(
        runPoll(env).catch((error) => {
          console.error("poll failed", error instanceof Error ? error.message : error);
        }),
      );
    } else {
      ctx.waitUntil(
        watchWebhook(env).catch((error) => {
          console.error("watch failed", error instanceof Error ? error.message : error);
        }),
      );
    }
  },
};
