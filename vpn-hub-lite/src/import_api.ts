/**
 * Приём ключей и статистика для локального скрипта обслуживания.
 *
 * Зачем через Worker: `wrangler d1 execute` на Windows регулярно падает с
 * spawn EPERM (антивирус), и скрипт оставался без базы. Здесь всё делает сам
 * Worker, а скрипт только шлёт HTTP.
 */

import { batch, many, one, prepare, run } from "./db";
import { checkTokenOk, envStr, timingSafeEqual } from "./security";
import type { Env } from "./types";

const UA = "Happ/2.9.1";
const MAX_LINKS = 200;

const CODE_TO_NAME: Record<string, string> = {
  GB: "United Kingdom", US: "United States", TR: "Turkiye", CN: "China",
  AE: "United Arab Emirates", BY: "Belarus", KZ: "Kazakhstan", RU: "Russia",
  FI: "Finland", DE: "Germany", NL: "The Netherlands", SE: "Sweden",
  FR: "France", PL: "Poland", EE: "Estonia", LT: "Lithuania", LV: "Latvia",
  CH: "Switzerland", IT: "Italy", ES: "Spain", AT: "Austria", CZ: "Czechia",
  JP: "Japan", SG: "Singapore", HK: "Hong Kong", CA: "Canada", KR: "South Korea",
  RO: "Romania", BG: "Bulgaria", HU: "Hungary", MD: "Moldova", UA: "Ukraine",
  RS: "Serbia", HR: "Croatia", SI: "Slovenia", NO: "Norway", DK: "Denmark",
  IE: "Ireland", BE: "Belgium", PT: "Portugal", GR: "Greece", IS: "Iceland",
  LU: "Luxembourg", MT: "Malta", CY: "Cyprus", SK: "Slovakia",
};

function authorized(env: Env, request: Request): Promise<boolean> {
  return checkTokenOk(env, request);
}

/**
 * Флаг из подписи ссылки → код страны. Флаг это два региональных символа.
 *
 * Берём последний флаг: в подписях провайдеров бывает «🇪🇺5G 🇳🇱 …» или
 * «🇷🇺 Россия → 🇩🇪 Германия», где первый флаг — не страна выхода. EU тоже
 * пропускаем: это не страна, и в клиенте вместо флага получается пустота.
 */
function countryFromLabel(label: string): string {
  const points = Array.from(label);
  let found = "";
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i].codePointAt(0) ?? 0;
    const b = points[i + 1].codePointAt(0) ?? 0;
    if (a >= 0x1f1e6 && a <= 0x1f1ff && b >= 0x1f1e6 && b <= 0x1f1ff) {
      const code =
        String.fromCharCode(65 + a - 0x1f1e6) + String.fromCharCode(65 + b - 0x1f1e6);
      if (code !== "EU") found = code;
    }
  }
  return found;
}

interface Parsed {
  remark: string;
  link: string;
  host: string;
  port: number;
  code: string;
}

function parseLinks(raw: string): Parsed[] {
  const rows: Parsed[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const link = line.trim();
    if (!/^vless:\/\//i.test(link)) continue;
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port || 443);
    const key = `${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let label = "";
    try {
      label = decodeURIComponent(url.hash.replace(/^#/, ""));
    } catch {
      label = "";
    }
    const points = Array.from(label);
    rows.push({
      remark: points.slice(0, 80).join("") || `${host}:${port}`,
      link,
      host,
      port,
      code: countryFromLabel(label),
    });
    if (rows.length >= MAX_LINKS) break;
  }
  return rows;
}

export async function handleImport(env: Env, request: Request): Promise<Response> {
  if (!(await authorized(env, request))) return new Response("forbidden", { status: 403 });

  let body: { name?: string; text?: string; url?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "нужен JSON {name, text|url}" }, { status: 400 });
  }

  let raw = String(body.text ?? "");
  const sourceUrl = String(body.url ?? "");
  if (!raw && sourceUrl && /^https?:\/\//i.test(sourceUrl)) {
    const res = await fetch(sourceUrl, { headers: { "user-agent": UA } });
    if (!res.ok) return Response.json({ error: `источник ответил HTTP ${res.status}` }, { status: 400 });
    raw = await res.text();
  }
  if (!raw.trim()) return Response.json({ error: "пустой текст ключей" }, { status: 400 });

  // Подписка может прийти целиком в base64.
  if (!/vless:\/\//i.test(raw)) {
    try {
      const decoded = atob(raw.trim());
      if (/vless:\/\//i.test(decoded)) raw = decoded;
    } catch {
      /* не base64 — значит просто текст без ссылок */
    }
  }

  const parsed = parseLinks(raw);
  if (!parsed.length) return Response.json({ error: "в тексте нет vless-ссылок" }, { status: 400 });

  const name = String(body.name ?? "").trim() || `Ключи ${new Date().toISOString().slice(0, 16)}`;

  await run(
    env,
    `INSERT INTO sources (name, kind, url_or_link, visibility, status) VALUES (?, 'public', ?, 'shareable', 'alive')`,
    name,
    raw.slice(0, 20000),
  );
  const source = await one<{ id: number }>(
    env,
    "SELECT id FROM sources WHERE name = ? ORDER BY id DESC LIMIT 1",
    name,
  );
  if (!source) return Response.json({ error: "не удалось создать источник" }, { status: 500 });

  const statements = parsed.map((row) =>
    prepare(
      env,
      `INSERT OR IGNORE INTO servers
         (source_id, remark, link, host, port, status, enabled, city, country_name, country_code)
       VALUES (?, ?, ?, ?, ?, 'unknown', 1, '', ?, ?)`,
      source.id,
      row.remark,
      row.link,
      row.host,
      row.port,
      CODE_TO_NAME[row.code] ?? "",
      row.code,
    ),
  );
  await batch(env, statements);

  const stored = await many<{ id: number; host: string; port: number; country_code: string }>(
    env,
    "SELECT id, host, port, country_code FROM servers WHERE source_id = ? ORDER BY id",
    source.id,
  );

  return Response.json({
    ok: true,
    sourceId: source.id,
    sourceName: name,
    links: parsed.length,
    stored: stored.length,
    ids: stored.map((s) => s.id),
  });
}

export async function handleStats(env: Env, request: Request): Promise<Response> {
  if (!(await authorized(env, request))) return new Response("forbidden", { status: 403 });
  const row = await one<{ total: number; alive: number; fresh: number; pool: number }>(
    env,
    `SELECT
       (SELECT COUNT(*) FROM servers WHERE enabled = 1) AS total,
       (SELECT COUNT(*) FROM servers WHERE enabled = 1 AND status = 'alive') AS alive,
       (SELECT COUNT(*) FROM servers WHERE enabled = 1 AND verified_at >= datetime('now','-24 hours')
                                              AND verified_latency_ms >= 1) AS fresh,
       (SELECT COUNT(*) FROM servers s JOIN sources src ON src.id = s.source_id
         WHERE s.enabled = 1 AND s.status = 'alive' AND s.verified_latency_ms >= 1
           AND s.verified_at >= datetime('now','-24 hours')
           AND s.country_code IS NOT NULL AND s.country_code <> ''
           AND src.visibility = 'shareable'
           AND (src.share_until IS NULL OR src.share_until > datetime('now'))
           AND src.name NOT LIKE '%Премиум%') AS pool`,
  );
  return Response.json(row ?? { total: 0, alive: 0, fresh: 0, pool: 0 });
}
