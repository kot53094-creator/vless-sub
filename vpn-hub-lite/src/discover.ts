/**
 * Автопоиск источников.
 *
 * Раз в сутки проверяем короткий список известных публичных подписок: живы
 * ли они, сколько в них конфигов, не добавлены ли уже. Новый источник
 * попадает в карантин (sources.quarantine = 1): sync его разбирает, агент
 * проверяет узлы, но в подписку людям они не идут, пока источник не докажет
 * качество — три узла, прошедшие трафик за 72 часа.
 *
 * Список адресов — не «поиск по интернету», а конкретные репозитории,
 * которые отдают plain-text подписку. Случайные ссылки из Telegram-каналов
 * не подключаем: проверить их происхождение нельзя.
 */

import { logEvent, many, one, run } from "./db";
import { sendToAdmin } from "./bot/telegram";
import type { Env } from "./types";

const MAX_BODY = 300_000;
const MIN_KEYS = 20;

interface Candidate {
  url: string;
  name: string;
}

/**
 * Публичные подписки. Все проверены вручную: отдают plain text или base64
 * со строками vless/vmess/trojan/ss, размер в пределах MAX_BODY.
 */
const CATALOG: Candidate[] = [
  {
    url: "https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub1.txt",
    name: "auto · barry-far/Sub1",
  },
  {
    url: "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/main/BLACK_VLESS_RUS.txt",
    name: "auto · igareck/ru",
  },
  {
    url: "https://raw.githubusercontent.com/ermaozi/get_subscribe/main/subscribe/v2ray.txt",
    name: "auto · ermaozi/v2ray",
  },
  {
    url: "https://raw.githubusercontent.com/SoliSpirit/v2ray-configs/main/all_configs.txt",
    name: "auto · SoliSpirit/all",
  },
];

const KEY_RE = /(?:vless|vmess|trojan|ss|hysteria2):\/\//g;

/**
 * Поиск по GitHub вместо ручного списка.
 *
 * API отдаёт репозитории, но не гарантирует содержимое: поэтому кандидат
 * проходит те же проверки, что и каталожный адрес — размер, свежесть,
 * количество конфигов. Лимит вызовов жёсткий: без токена GitHub даёт
 * 60 запросов в час на IP, а IP у воркера общий с другими воркерами
 * Cloudflare, так что экономим (3 поиска + не больше 4 листингов).
 */
const SEARCH_QUERIES = ["v2ray configs", "free vless", "v2ray subscription"];
const MAX_REPOS_PER_QUERY = 6;
const MAX_SEARCH_CANDIDATES = 4;
const MAX_API_CALLS = 8;

interface GhRepo {
  full_name: string;
  default_branch: string;
  archived: boolean;
  pushed_at: string;
  size: number;
}

interface GhFile {
  name: string;
  path: string;
  type: string;
  size: number;
}

/**
 * Файлы-кандидаты: любой .txt разумного размера.
 *
 * Имя файла ничего не гарантирует: у живых репозиториев встречаются
 * `jafar.txt`, `mix.txt`, `Sub1.txt`. Решает содержимое — его проверяет
 * countKeys, а мусор вроде `requirements.txt` даёт ноль ссылок и отсеивается.
 */
export function pickTextFiles(files: GhFile[]): GhFile[] {
  return files
    .filter((file) => file.type === "file" && /\.txt$/i.test(file.name) && file.size < 2_000_000)
    .slice(0, 3);
}

async function ghToken(env: Env): Promise<string> {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  // Резерв в D1: токен можно положить без перезапуска воркера, если секрет
  // не задаётся с машины. Без токена GitHub даёт 60 запросов в час на IP,
  // а IP у воркера общий — поиск начинает молча получать 403.
  try {
    const row = await one<{ value: string }>(
      env,
      "SELECT value FROM settings WHERE key = 'github_token'",
    );
    return (row?.value ?? "").trim();
  } catch {
    return "";
  }
}

async function ghJson<T>(
  env: Env,
  path: string,
  budget: { calls: number; token: string },
): Promise<T | null> {
  if (budget.calls >= MAX_API_CALLS) return null;
  budget.calls += 1;
  const headers: Record<string, string> = {
    "user-agent": "vpn-hub-lite/discover",
    accept: "application/vnd.github+json",
  };
  // Токен не обязателен: с ним лимит выше, без него хватает 8 вызовов в сутки.
  if (budget.token) headers.authorization = `Bearer ${budget.token}`;
  try {
    const response = await fetch(`https://api.github.com${path}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Кандидаты из поиска GitHub: только свежие, живые и не добавленные. */
export async function searchGithub(
  env: Env,
  known: (url: string) => boolean,
): Promise<{ candidates: Candidate[]; calls: number; responses: number }> {
  let responses = 0;
  const found: Candidate[] = [];
  const budget = { calls: 0, token: await ghToken(env) };
  const month = 45 * 86_400_000;

  for (const query of SEARCH_QUERIES) {
    if (found.length >= MAX_SEARCH_CANDIDATES || budget.calls >= MAX_API_CALLS) break;
    const data = await ghJson<{ items?: GhRepo[] }>(
      env,
      `/search/repositories?q=${encodeURIComponent(query + " in:name,description")}` +
        `&sort=updated&order=desc&per_page=${MAX_REPOS_PER_QUERY}`,
      budget,
    );
    if (!data?.items) continue;
    responses += 1;

    for (const repo of data.items) {
      if (found.length >= MAX_SEARCH_CANDIDATES || budget.calls >= MAX_API_CALLS) break;
      if (repo.archived || repo.size > 60_000) continue;
      const pushed = Date.parse(repo.pushed_at);
      if (!Number.isFinite(pushed) || Date.now() - pushed > month) continue;
      if (known(`https://raw.githubusercontent.com/${repo.full_name}/`)) continue;

      const files = await ghJson<GhFile[]>(env, `/repos/${repo.full_name}/contents/`, budget);
      if (!Array.isArray(files)) continue;
      for (const file of pickTextFiles(files)) {
        found.push({
          url: `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/${file.path}`,
          name: `auto · ${repo.full_name}/${file.name}`,
        });
      }
    }
  }

  return { candidates: found, calls: budget.calls, responses };
}

export interface DiscoverResult {
  added: string[];
  skipped: number;
  failed: string[];
  promoted: string[];
  /** Диагностика поиска: вызовы API и сколько ответов дошло. */
  search?: { calls: number; responses: number };
}

/** Сколько конфигов в теле подписки. */
export function countKeys(text: string): number {
  return (text.match(KEY_RE) ?? []).length;
}

/**
 * Промоушен карантина: источник доказал качество — снимаем флаг.
 * Условие намеренно жёсткое: три узла, прошедшие именно проверку трафиком,
 * а не открытый порт.
 */
export async function promoteQuarantine(env: Env): Promise<string[]> {
  const rows = await many<{ id: number; name: string; verified: number }>(
    env,
    `SELECT s.id, s.name,
            COUNT(v.id) AS verified
       FROM sources s
       JOIN servers v ON v.source_id = s.id
      WHERE s.quarantine = 1
        AND v.enabled = 1
        AND v.status = 'alive'
        AND v.verified_latency_ms > 0
        AND v.verified_at >= datetime('now','-72 hours')
      GROUP BY s.id
     HAVING COUNT(v.id) >= 3`,
  );

  const promoted: string[] = [];
  for (const row of rows) {
    await run(env, "UPDATE sources SET quarantine = 0, status = 'alive' WHERE id = ?", row.id);
    // Включаем узлы обратно: в карантине sync держал их с enabled = 0.
    await run(env, "UPDATE servers SET enabled = 1 WHERE source_id = ?", row.id);
    await logEvent(env, "discover", null, `карантин снят: ${row.name} (${row.verified} узлов)`);
    promoted.push(row.name);
  }
  return promoted;
}

/** Основной прогон: добавить новые источники, снять карантин с проверенных. */
async function tryAdd(
  env: Env,
  candidate: Candidate,
  result: DiscoverResult,
): Promise<boolean> {
  const existing = await one<{ id: number }>(
    env,
    "SELECT id FROM sources WHERE url_or_link = ?",
    candidate.url,
  );
  if (existing) {
    result.skipped++;
    return false;
  }

  try {
    const response = await fetch(candidate.url, {
      headers: { "user-agent": "vpn-hub-lite/discover" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      result.failed.push(`${candidate.name}: HTTP ${response.status}`);
      return false;
    }
    const text = (await response.text()).slice(0, MAX_BODY);
    const keys = countKeys(text);
    if (keys < MIN_KEYS) {
      result.failed.push(`${candidate.name}: всего ${keys} конфигов`);
      return false;
    }
    await run(
      env,
      `INSERT INTO sources (name, kind, url_or_link, visibility, status, quarantine)
       VALUES (?, 'public', ?, 'shareable', 'unknown', 1)`,
      candidate.name,
      candidate.url,
    );
    await logEvent(env, "discover", null, `новый источник: ${candidate.name} (${keys})`);
    result.added.push(`${candidate.name} (${keys})`);
    return true;
  } catch (error) {
    result.failed.push(
      `${candidate.name}: ${error instanceof Error ? error.message.slice(0, 80) : "error"}`,
    );
    return false;
  }
}

/** Основной прогон: каталог → поиск по GitHub → карантин → промоушен. */
export async function runDiscovery(env: Env): Promise<DiscoverResult> {
  const result: DiscoverResult = { added: [], skipped: 0, failed: [], promoted: [] };

  for (const candidate of CATALOG) {
    await tryAdd(env, candidate, result);
  }

  const rows = await many<{ u: string }>(env, "SELECT url_or_link AS u FROM sources");
  const known = rows.map((row) => row.u);
  let fromSearch = 0;
  const search = await searchGithub(env, (prefix) => known.some((url) => url.startsWith(prefix)));
  result.search = { calls: search.calls, responses: search.responses };
  for (const candidate of search.candidates) {
    if (fromSearch >= MAX_SEARCH_CANDIDATES) break;
    if (await tryAdd(env, candidate, result)) fromSearch += 1;
  }

  result.promoted = await promoteQuarantine(env);

  if (result.added.length || result.promoted.length) {
    await sendToAdmin(
      env,
      [
        "Автопоиск источников:",
        result.added.length ? `добавлено в карантин: ${result.added.join(", ")}` : "",
        result.promoted.length ? `снят карантин: ${result.promoted.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result;
}
