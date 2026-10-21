/** Точка входа Worker: подписки, вебхук бота, админка, cron. */

import { handleAdmin } from "./admin";
import { handleUpdate, type TgUpdate } from "./bot";
import { runHealth } from "./health";
import { timingSafeEqual } from "./security";
import { handleSubscription } from "./sub";
import { runSync } from "./sync";
import type { Env } from "./types";

const SYNC_CRON = "0 */6 * * *";

function landing(env: Env): Response {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VPN Hub Lite</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e8ecf3;
font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.card{max-width:520px;padding:26px;border:1px solid #262b36;border-radius:16px;background:#171a21}
h1{margin:0 0 6px;font-size:22px}p{color:#8b95a7;margin:0 0 12px}
code{background:#12151b;border:1px solid #262b36;border-radius:6px;padding:1px 5px;font-size:13px}
a{color:#ff8a3d}
</style></head><body><div class="card">
<h1>VPN Hub Lite</h1>
<p>Персональные подписки для Happ. Ссылку выдаёт Telegram-бот после одобрения.</p>
<p>Пользователям: откройте бота и отправьте <code>/start</code>.</p>
<p>Админ: <a href="/admin">панель управления</a>.</p>
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

    if (path.startsWith("/sub/")) {
      const token = decodeURIComponent(path.slice("/sub/".length)).replace(/\/$/, "");
      return await handleSubscription(env, token, request);
    }

    if (path === "/webhook" && request.method === "POST") {
      const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
      if (!env.WEBHOOK_SECRET || !timingSafeEqual(provided, env.WEBHOOK_SECRET)) {
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
        handleUpdate(env, update).catch((error) => {
          console.error("bot update failed", error instanceof Error ? error.message : error);
        }),
      );
      return new Response("ok");
    }

    if (path === "/admin" || path.startsWith("/admin/")) {
      return await handleAdmin(request, env);
    }

    if (path === "/") return landing(env);

    return new Response("Не найдено", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === SYNC_CRON) {
      ctx.waitUntil(
        runSync(env).catch((error) => {
          console.error("sync failed", error instanceof Error ? error.message : error);
        }),
      );
      return;
    }
    ctx.waitUntil(
      runHealth(env).catch((error) => {
        console.error("health failed", error instanceof Error ? error.message : error);
      }),
    );
  },
};
