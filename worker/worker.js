/**
 * Апельсинка VPN — учёт устройств.
 *
 * Один файл для Cloudflare Workers (бесплатный тариф: 100 000 запросов в сутки).
 * Что делает:
 *   GET /s/<device>  — отдаёт подписку и записывает, что устройство <device>
 *                      её забрало: время, страна, клиент, сколько раз.
 *   GET /api/stats   — JSON со списком устройств для dashboard.html.
 *
 * Устройства различаются по метке в адресе: /s/phone, /s/pc, /s/tablet.
 * Один и тот же адрес без метки (/sub) считается устройством "default".
 *
 * IP не сохраняется: пишется только страна и короткий хеш, чтобы считать
 * уникальность и не держать персональные данные.
 */

const SOURCE = "https://kot53094-creator.github.io/vless-sub/sub-ru.txt";
const TITLE = "Апельсинка впн";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

async function sha1(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

async function logHit(env, device, request) {
  const now = new Date().toISOString();
  const key = `dev:${device}`;
  const prev = await env.STATS.get(key, "json");
  const ip = request.headers.get("cf-connecting-ip") || "";
  const record = {
    device,
    first_seen: prev?.first_seen || now,
    last_seen: now,
    hits: (prev?.hits || 0) + 1,
    country: request.cf?.country || prev?.country || "",
    client: (request.headers.get("user-agent") || "").slice(0, 60),
    ip_hash: await sha1(ip + "apelsinka"),
  };
  await env.STATS.put(key, JSON.stringify(record));

  const day = now.slice(0, 10);
  const dayKey = `day:${day}`;
  const dayCount = parseInt((await env.STATS.get(dayKey)) || "0", 10) + 1;
  await env.STATS.put(dayKey, String(dayCount));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/api/health") {
      return json({ ok: true, service: "apelsinka-vpn", source: SOURCE });
    }

    if (url.pathname === "/api/stats") {
      const list = await env.STATS.list({ prefix: "dev:" });
      const devices = [];
      for (const key of list.keys) {
        const value = await env.STATS.get(key.name, "json");
        if (value) devices.push(value);
      }
      devices.sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));

      const days = await env.STATS.list({ prefix: "day:" });
      const history = [];
      for (const key of days.keys.slice(-30)) {
        history.push({ day: key.name.slice(4), hits: parseInt((await env.STATS.get(key.name)) || "0", 10) });
      }
      return json({ devices, history, updated: new Date().toISOString() });
    }

    const match = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{1,32})$/);
    if (match) {
      const device = match[1].toLowerCase();
      const upstream = await fetch(SOURCE, {
        cf: { cacheTtl: 60, cacheEverything: true },
        headers: { "user-agent": request.headers.get("user-agent") || "v2rayNG" },
      });
      const body = await upstream.text();
      if (upstream.ok) {
        await logHit(env, device, request).catch(() => {});
      }
      return new Response(body, {
        status: upstream.status,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "profile-title": "base64:" + btoa(unescape(encodeURIComponent(TITLE))),
          "profile-update-interval": "6",
          "cache-control": "no-store",
        },
      });
    }

    return json({ error: "not found", hint: "use /s/<device>" }, 404);
  },
};
