/**
 * Персональная подписка /sub/<token>.
 *
 * Особенности:
 *  • отдаём только живые серверы из shareable-источников;
 *  • paid_private и visibility=private не попадают сюда никогда;
 *  • ответ кэшируется в KV на SUB_CACHE_TTL секунд;
 *  • fetch_log пишется не чаще раза в час на пользователя.
 */

import { many, one, run, logEvent } from "./db";
import { buildSubscription, parseUri, withLabel } from "./parser";
import { serverLabel } from "./labels";
import {
  clientIp,
  hashValue,
  memRateLimit,
  randomToken,
  envStr,
  timingSafeEqual,
} from "./security";
import type { DeliverableServer, Env, UserRow } from "./types";
import { BRAND_PREMIUM } from "./brand";
import { planDefaults, premiumHeaders, subscriptionUserinfo } from "./premium";
import { buildAutoConfig } from "./xray_json";
import { buildSingBoxConfig } from "./singbox_json";
import { assignIfEmpty } from "./balance";
import { compareServers, isModern, rotateTail } from "./ranking";
import { checkReality } from "./reality";
import { normalizeVlessLink } from "./normalize";
import { recordVersion } from "./sub_versions";
import { recordPresence, snapshot } from "./presence";
import { routingLink } from "./routing";
import { appendMergedLinks } from "./merge";

/**
 * Как часто клиент сам перечитывает подписку, часы.
 * Это же и частота, с которой админ видит, включён ли у человека туннель,
 * поэтому 1 час вместо 6: дороже по запросам, но статус не «позавчерашний».
 */
export const PROFILE_REFRESH_HOURS = 1;

/**
 * Ротация запасной части списка, минуты.
 *
 * Как в платных VPN: сверху всегда закреплены самые быстрые проверенные
 * узлы (автовыбор клиента берёт первые), а остальной список каждые
 * ROTATION_MINUTES минут перемешивается заново. Запасные узлы получают
 * равномерную нагрузку, свежепроверенные подмешиваются в выдачу, и падение
 * одного источника не оставляет полсписка на одних и тех же позициях.
 */
const ROTATION_MINUTES = 15;

/** Сколько узлов закрепить сверху без ротации: премиум + быстрые. */
const ROTATION_PINNED = 3;

const SERVER_COLUMNS = `
  s.id, s.source_id, s.remark, s.link, s.host, s.port, s.status,
  s.latency_ms, s.last_check_at, s.max_users, s.seen_at,
  s.verified_at, s.verified_latency_ms, s.blocked_ok, s.exit_ip, s.speed_mbps,
  s.country_name, s.city, s.country_code, s.tier, s.enabled, s.priority,
  src.visibility, src.share_until, src.kind AS source_kind`;
// Подзапрос за pool_name убран намеренно: имя пула нигде не показывается, а
// коррелированный подзапрос выполняется для каждой строки выборки. На пуле из
// 60 узлов это тысячи прочитанных строк D1 за каждую сборку снимка — на
// бесплатной квоте такие мелочи и съедают суточный лимит.

const SERVER_TAIL = `
  FROM assignments a
  JOIN servers s ON s.id = a.server_id
  JOIN sources src ON src.id = s.source_id
  WHERE a.user_id = ?1 AND s.status IN ('alive', 'unknown')
    AND (src.visibility = 'shareable' OR ?2 = 1)
    AND (src.kind <> 'paid_private' OR ?2 = 1)
    AND (
      src.max_devices = 0
      OR EXISTS (SELECT 1 FROM user_sources us
                  WHERE us.user_id = a.user_id AND us.source_id = src.id)
    )
  ORDER BY (s.status = 'alive') DESC, (s.priority IS NULL), s.priority DESC,
           (s.latency_ms IS NULL), s.latency_ms, s.id`;

const SERVER_SQL = `
  SELECT ${SERVER_COLUMNS},
         -- Доля успешных проверок из последних десяти: основа рейтинга.
         -- Только kind='tunnel': открытый TCP-порт работоспособность VPN
         -- не доказывает и в рейтинг идти не должен.
         COALESCE((SELECT AVG(c.result = 'ok') FROM (
             SELECT result FROM server_checks c2
              WHERE c2.server_id = s.id AND c2.kind = 'tunnel'
              ORDER BY c2.id DESC LIMIT 10) c), 0) AS stability
  ${SERVER_TAIL}`;

/**
 * Облегчённая выборка для строгого режима: подзапрос стабильности не нужен,
 * если работа проверяется по verified_latency_ms. Это в разы меньше строк
 * чтения D1 — на бесплатном тарифе разница принципиальная.
 */
const SERVER_SQL_LIGHT = `
  SELECT ${SERVER_COLUMNS}, 0 AS stability
  ${SERVER_TAIL}`;

/** Защита в глубину: даже если SQL что-то пропустит, приватное не уйдёт. */
export function isShareActive(
  source: { share_until?: string | null },
  now = Date.now(),
): boolean {
  if (!source.share_until) return true;
  const until = Date.parse(`${source.share_until.replace(" ", "T")}Z`);
  if (!Number.isFinite(until)) return true;
  return until > now;
}

export function isDeliverable(
  server: {
    visibility?: string;
    share_until?: string | null;
    source_kind?: string;
    status?: string;
  },
  allowPrivate = false,
  now = Date.now(),
): boolean {
  if (server.status && server.status !== "alive" && server.status !== "unknown") return false;
  // Приватные и оплаченные источники не уходят никому, кроме владельца:
  // для него allowPrivate=true, для остальных — жёсткий отсев.
  if (!allowPrivate) {
    if (server.visibility !== "shareable") return false;
    if (server.source_kind === "paid_private") return false;
    // Общий доступ может быть временным: срок истёк — снова приватно.
    if (!isShareActive(server, now)) return false;
  }
  return true;
}

function stubBody(reason: string): string {
  const remark = encodeURIComponent(reason);
  const fake =
    `vless://00000000-0000-0000-0000-000000000000@127.0.0.1:1` +
    `?encryption=none&security=none&type=tcp#${remark}`;
  return buildSubscription([fake]);
}

function timedOutStatus(user: UserRow | null): string | null {
  if (!user) return "Подписка не найдена — напишите боту /start";
  if (user.status === "banned") return "Доступ закрыт — напишите админу";
  if (user.status === "pending") return "Заявка ещё не одобрена — подождите";
  // Дата важнее статуса. Поле status выставляет автоматика по расписанию, и
  // после продления срока вручную оно остаётся 'expired' — из-за этого
  // подписка писала «срок истёк» при действующем доступе.
  if (user.expires_at) {
    const ts = Date.parse(user.expires_at.replace(" ", "T") + "Z");
    if (Number.isFinite(ts)) {
      if (ts > Date.now()) return null;
      return "Срок истёк — напишите боту";
    }
  }
  if (user.status === "expired") return "Срок истёк — напишите боту";
  return null;
}

/**
 * Строгий режим подписки: только VLESS + REALITY, которые прошли настоящую
 * проверку через туннель. Включается по умолчанию, отключается STRICT_WORKING=0
 * — тогда в выдачу вернётся весь REALITY-пул, включая непроверенные.
 */
export function isStrictDefault(env: Env): boolean {
  return (env.STRICT_WORKING ?? "1") !== "0";
}

/**
 * Единственный критерий «конфигурация реально работает»: современный
 * Xray-протокол (REALITY или WS+TLS) плюс успешная проверка через туннель.
 * Синтаксической корректности недостаточно — нужен факт соединения.
 */
export function isWorkingServer(
  server: {
    link: string;
    visibility?: string;
    verified_at?: string | null;
    verified_latency_ms?: number | null;
    blocked_ok?: number | null;
  },
  // 72 часа вместо 12: проверки идут пачками и не всегда успевают обойти
  // весь пул за сутки. При 12 часах подписка внезапно пустела целиком,
  // хотя узлы работали — человек видел «нет серверов».
  maxAgeMs = 72 * 60 * 60 * 1000,
): boolean {
  // Узел, который не открывает Telegram/Discord, в подписке бесполезен.
  // NULL = ещё не проверяли, такие не отбрасываем, чтобы не обнулить пул.
  if (server.blocked_ok === 0) return false;

  // Премиум-узлы больше не исключение: раньше они шли мимо туннель-проверки
  // («проверены владельцем»), и в автовыборе сверху висели мёртвые
  // astra/spacessupport. Правило одно для всех — работает то, что реально
  // прошло проверку за сутки.

  const latency = server.verified_latency_ms ?? 0;
  if (latency <= 0) return false;
  if (!server.verified_at) return false;

  // Срок годности проверки: узел, проверенный сутки назад, уже не «рабочий» —
  // именно из-за таких записей подписка «то работает, то нет».
  const ts = Date.parse(`${server.verified_at.replace(" ", "T")}Z`);
  if (!Number.isFinite(ts)) return false;
  if (Date.now() - ts > maxAgeMs) return false;

  return isModern(server);
}

/**
 * Ссылка для подписки.
 *
 * normalizeVlessLink умеет только VLESS: для vmess, trojan, hysteria2, ss он
 * возвращает пустую строку, и узел молча исчезал из выдачи. Такие схемы клиент
 * разбирает сам, поэтому отдаём их без изменений.
 */
function cleanLink(link: string): string {
  if (!/^vless:\/\//i.test(link)) return link;
  const normalized = normalizeVlessLink(link);
  return normalized || link;
}

/** Режимы отбора: REALITY-only и производные от него. */
export type SubMode =
  | "default"
  | "reality"
  | "working"
  | "best"
  | "stable"
  | "low-latency"
  | "untested"
  /** JSON-конфиг Xray с автоподбором живого узла. */
  | "auto"
  /** Обычный список ссылок: резерв для клиентов без поддержки JSON. */
  | "plain"
  /** sing-box конфиг с urltest: автоматический выбор узла. */
  | "sb"
  /** Обычный список ссылок: резерв для клиентов без поддержки JSON. */
  | "plain"
  /** sing-box конфиг с urltest: автоматический выбор узла. */
  | "sb"
  | "byedpi";

/**
 * Внешняя обёртка: при исчерпании лимитов D1 Worker не должен отдавать
 * «error code: 1101». Клиент получает понятную заглушку, а подписка
 * восстановится сама, когда лимит сбросится.
 */
/**
 * Снимок проверенного пула в KV.
 *
 * Зачем: список серверов у всех один и тот же — проверенные узлы из общих
 * источников. Дёргать ради него D1 на каждое обновление подписки бессмысленно:
 * строим снимок раз в 15 минут, остальные запросы читают KV. Так база уходит
 * с горячего пути, а подписка продолжает обновляться.
 */
const POOL_KEY = "pool:verified:v19";
const POOL_KEY_PREMIUM = "pool:verified:premium:v11";
// Отдельный ключ для владельца: его снимок содержит личные узлы
// (tier='personal'), которых не должно быть в кэше премиум-пользователей.
const POOL_KEY_OWNER = "pool:verified:owner:v2";
const POOL_KEY_WHITELIST = "pool:whitelist:v1";
const POOL_TTL = 3600;

/**
 * Сколько живёт резервная копия подписки — 7 суток.
 *
 * Раньше снимок жил один день. Если за эти сутки сборка падала (квота D1,
 * пустой пул, сбой источника), человек получал заглушку «нет серверов» —
 * то есть VPN «умирал» при живых узлах в базе. Неделя резерва перекрывает
 * любой плановый сбой: клиент обновляет подписку раз в час, и рано или
 * поздно получит рабочий список снова.
 */
const SNAPSHOT_TTL = 7 * 24 * 3600;

/**
 * Закреплённые узлы — якорь подписки.
 *
 * Ссылки заданы вручную и не зависят ни от базы, ни от пула, ни от проверок:
 * они всегда стоят первыми в любой подписке и остаются в аварийном снимке.
 * Если такой узел встречается в базе или прямом резерве, оттуда он
 * выбрасывается — иначе в списке была бы вторая строка с той же парой
 * host:port, но другой подписью.
 */
const PINNED_LINKS: { link: string; label: string }[] = [
  {
    link: "vless://d3b30ef2-0972-43b8-9300-093c67227de8@pl-users.golu-gulu.online:443?type=grpc&security=reality&sni=pl-users.golu-gulu.online&fp=firefox&pbk=vndjTES0bDFmT7rh4vpP8BVs8-J3TDsA5wVgct8cr20&sid=c4f2e8a16b903d75&serviceName=UserVideo",
    label: "🇪🇺 Авто-выбор | Обычный VPN",
  },
  {
    link: "vless://d3b30ef2-0972-43b8-9300-093c67227de8@pl-users.golu-gulu.online:443?type=grpc&security=reality&sni=pl-users.golu-gulu.online&fp=firefox&pbk=vndjTES0bDFmT7rh4vpP8BVs8-J3TDsA5wVgct8cr20&sid=c4f2e8a16b903d75&serviceName=UserVideo",
    label: "🇵🇱 Польша",
  },
  {
    link: "vless://d3b30ef2-0972-43b8-9300-093c67227de8@nl.golu-gulu.online:443?type=grpc&security=reality&sni=nl.golu-gulu.online&fp=qq&pbk=Nslv-ty-rHpyBL9jFin2qCYINXxdZNCC1P4wb2YJoiM&sid=a2380263612e79db&serviceName=grpc-vk",
    label: "🇳🇱 Нидерланды",
  },
  {
    link: "vless://d3b30ef2-0972-43b8-9300-093c67227de8@fr.golu-gulu.online:443?type=grpc&security=reality&sni=fr.golu-gulu.online&fp=qq&pbk=Nslv-ty-rHpyBL9jFin2qCYINXxdZNCC1P4wb2YJoiM&sid=a2380263612e79db&serviceName=grpc-vk",
    label: "🇫🇷 Франция",
  },
  {
    link: "vless://d3b30ef2-0972-43b8-9300-093c67227de8@ru2.golu-gulu.online:9999?type=tcp&security=reality&flow=xtls-rprx-vision&sni=ru2.golu-gulu.online&fp=firefox&pbk=KGU-UIM6HlNYuaBD5WMTLkG8mqR__mVSxF2smO_lTjw&sid=a2380263612e79db",
    label: "🇷🇺 Ru-сервисы | Если вы зарубежом",
  },
  {
    link: "vless://d3b30ef2-0972-43b8-9300-093c67227de8@ee-users.golu-gulu.online:443?type=grpc&security=reality&sni=ee-users.golu-gulu.online&fp=firefox&pbk=_46X6-C3E-Ks9pzAG4XBBH74uDAAAl0AoshlCbeKU0U&sid=c4f2e8a16b903d75&serviceName=ee-users",
    label: "🇪🇪 Эстония",
  },
  {
    link: "vless://d3b30ef2-0972-43b8-9300-093c67227de8@gr.golu-gulu.online:443?type=tcp&security=reality&flow=xtls-rprx-vision&sni=gr.golu-gulu.online&fp=qq&pbk=KGU-UIM6HlNYuaBD5WMTLkG8mqR__mVSxF2smO_lTjw&sid=a2380263612e79db",
    label: "🇬🇷 Греция",
  },
  {
    link: "vless://d3b30ef2-0972-43b8-9300-093c67227de8@alyt.golu-gulu.online:443?type=tcp&security=reality&flow=xtls-rprx-vision&sni=alyt.golu-gulu.online&fp=firefox&pbk=xkl9goRCVqCwoatSn_svrHkzlcmu7APwhr7XfdC6jTU&sid=a2380263612e79db",
    label: "🇦🇱 Албания",
  },
  {
    link: "vless://d3b30ef2-0972-43b8-9300-093c67227de8@fi.users.golu-gulu.online:443?type=tcp&security=reality&flow=xtls-rprx-vision&sni=fi.users.golu-gulu.online&fp=firefox&pbk=ZPjkqL8oFJ27Oa8ETFfSC_S2EHnGl8TyN5ujzYwMknw&sid=7d19a6e4c2f8305b",
    label: "🇫🇮 Финляндия",
  },
  {
    link: "vless://d3b30ef2-0972-43b8-9300-093c67227de8@jp-ch.users.golu-gulu.online:443?type=grpc&security=reality&sni=jp-ch.users.golu-gulu.online&fp=qq&pbk=ja7ib9JvaB3uUFPYz4X5IEAfl2IcLS694Vmq66waD38&sid=a34f8c1d6e2b9075&serviceName=jp-ch-users",
    label: "🇯🇵 Япония",
  },
];

/** host:port из ссылки — сравнение узлов без учёта подписи. */
function endpointOfLink(link: string): string {
  try {
    const body = link.slice(link.indexOf("://") + 3).split("#")[0];
    const hostPort = body.split("@").pop()?.split("?")[0] ?? "";
    return hostPort.replace(/\/+$/, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Ставит якоря в начало и убирает их дубли из остального списка.
 * Вызывается после прямого резерва, поэтому закреплённые узлы оказываются
 * самыми первыми и не могут быть вытеснены ни базой, ни проверками.
 */
function applyPinnedLinks(uris: string[]): void {
  const anchored = new Set(PINNED_LINKS.map((pin) => endpointOfLink(pin.link)));
  for (let i = uris.length - 1; i >= 0; i -= 1) {
    if (anchored.has(endpointOfLink(uris[i]))) uris.splice(i, 1);
  }
  uris.unshift(...PINNED_LINKS.map((pin) => withLabel(cleanLink(pin.link), pin.label)));
}

/**
 * От старых импортов Astra в базе остались строки с подписью «Премиум сервер»:
 * ни страны, ни флага, в клиенте они выглядят как неразличимые клоны.
 * Настоящий премиум-узел отличается тем, что у него tier='premium' и есть
 * страна, поэтому всё остальное с такой подписью считаем мусором.
 */
const PLACEHOLDER_REMARK = /^\s*Премиум сервер\b/i;

/**
 * Узлы, которые проверка 04–05.11.2026 признала мёртвыми по реальному
 * туннелю (TCP открыт, данные не идут). Они всё ещё лежат в базе как
 * «alive» — повторных проверок не было, — поэтому режем их здесь, не
 * дожидаясь D1: подписка не должна предлагать «Connected без интернета».
 * Список временный: после свежих проверок его можно очистить целиком.
 */
const KNOWN_DEAD_HOSTS = new Set([
  "de-2.ffpn.pro",
  "swo2.nexfile.net",
  "9.247.23.209",
  "84.23.52.120",
  "proxymite.waldron.ir",
  "156.252.229.188",
  // Проверка 06.11.2026 через Xray: TCP открывается, данные не идут.
  "104.171.133.209",
  "147.45.148.6",
  "185.126.93.227",
  "186.246.9.29",
  "188.116.27.6",
  "212.69.135.70",
  "45.132.75.213",
  "47.245.134.84",
  "5.253.28.224",
  "54.251.9.130",
  "78.159.250.214",
  "88.216.223.100",
  "du-rov.secureservice.top",
  "edge.bookmai.com",
  "pl1.h1cloud.net",
  "rm2.rmastore.ir",
  "tgfree.rush-server.com",
]);

function isPlaceholder(row: DeliverableServer): boolean {
  return row.tier !== "premium" && PLACEHOLDER_REMARK.test(String(row.remark ?? ""));
}

function isRussian(row: DeliverableServer): boolean {
  const code = String(row.country_code ?? "").toUpperCase();
  const name = String(row.country_name ?? "").toLowerCase();
  return code === "RU" || name.includes("росси") || name.includes("russia");
}

/**
 * Узел для первой строки подписки.
 *
 * Сначала выборка узлов, проверенных трафиком за сутки: среди них берём
 * самый близкий, при равном пинге — самый быстрый. Если свежих нет вовсе,
 * честно берём лучший из того, что есть: пустая первая строка хуже.
 */
export function pickBest(
  list: DeliverableServer[],
  skip = 0,
): DeliverableServer | null {
  const candidates = list.slice(skip);
  if (candidates.length === 0) return null;
  const fresh = candidates.filter((row) => isWorkingServer(row, 24 * 60 * 60 * 1000));
  const pool = fresh.length > 0 ? fresh : candidates;
  return [...pool].sort(
    (a, b) =>
      (a.verified_latency_ms ?? 1e9) - (b.verified_latency_ms ?? 1e9) ||
      (b.speed_mbps ?? 0) - (a.speed_mbps ?? 0) ||
      a.id - b.id,
  )[0];
}

export async function loadPool(
  env: Env,
  premium = false,
  fresh = false,
  // owner — админ: ему дополнительно отдаём личные узлы (tier='personal').
  // Это локальный снимок платной подписки: он не должен попадать в общий пул.
  owner = false,
): Promise<DeliverableServer[]> {
  // Ключ кэша зависит от тарифа: иначе премиум-снимок читался бы обычным
  // пользователям, а они не должны видеть приватные узлы.
  const key = owner && premium ? POOL_KEY_OWNER : premium ? POOL_KEY_PREMIUM : POOL_KEY;
  // Админ всегда получает свежую сборку: иначе проверить правки фильтров
  // невозможно — ответ приходит из часового кэша и выглядит как «ничего не
  // изменилось».
  // Кэш читаем всегда: он же резерв, когда база недоступна. Админу всё равно
  // нужна свежая сборка, поэтому ниже он идёт в D1, но при ошибке получает
  // пул из KV, а не исключение и не старое тело подписки.
  // Режим «только присланные ключи». Флаг ставится вручную: подписка отдаёт
  // ровно те узлы, что проверены и залиты, и не подмешивает базу. Нужен, когда
  // владелец присылает свежий набор и требует оставить только его.
  // Флаг живёт 48 часов — потом автоматика возвращается сама.
  try {
    const only = await env.CACHE.get<DeliverableServer[]>("pool:rescue:v1", "json");
    if (only && only.length) return only;
  } catch {
    // KV недоступен — идём обычным путём
  }

  let cached = await env.CACHE.get<DeliverableServer[]>(key, "json");
  // У админа и премиума свои ключи пула. Они могут быть пустыми (например,
  // когда пул только что залит в общий ключ) — тогда берём общий: список
  // серверов у всех одинаковый, отдельные ключи нужны лишь для приватных узлов.
  if ((!cached || cached.length === 0) && key !== POOL_KEY) {
    cached = await env.CACHE.get<DeliverableServer[]>(POOL_KEY, "json");
  }
  if (cached && cached.length && !fresh) return cached;

  let rows: DeliverableServer[];
  try {
    rows = await many<DeliverableServer>(
    env,
    `SELECT ${SERVER_COLUMNS}, 0 AS stability
       FROM servers s
       JOIN sources src ON src.id = s.source_id
      WHERE s.verified_latency_ms > 0
        -- Окно 72 часа, а не сутки: проверки идут пачками и не успевают
        -- обойти пул за день. Свежие всё равно идут первыми (сортировка
        -- ниже), но резерв не обнуляется — иначе подписка «худеет» до
        -- нескольких узлов и человек видит старый мёртвый список.
        AND s.verified_at >= datetime('now','-72 hours')
        -- Мягкий потолок: до 600 мс узлы идут первыми, до 800 добирают
        -- остаток. Жёсткие 600 при текущих источниках оставляли шесть строк
        -- из тысячи восьмисот — пусть лучше будет запасной вариант на
        -- 700 мс, чем пустой список.
        -- Потолок 800 мс для обычных источников. Узлы личного ключа eclvpn
        -- идут через цепочку geo-entry: они живые, но 900–1100 мс, поэтому
        -- для них отдельная поблажка. Сортировка всё равно ставит их в конец.
        AND (
          s.verified_latency_ms <= 800
          OR (src.name LIKE 'ECL%' AND s.verified_latency_ms <= 1100)
        )
        -- Telegram обязателен, YouTube — приоритет, но не приговор. Узлы,
        -- открывающие только Telegram, всё равно обходят белые списки; при
        -- жёстком требовании обоих сервисов список схлопывался до одного.
        AND (s.blocked_ok = 1 OR s.blocked_probe LIKE '%tg:ok%')
        AND s.enabled = 1
        -- Только подтверждённо живые. Раньше допускался 'unknown', и узел,
        -- у которого проверка уже провалилась, продолжал висеть в подписке до
        -- второй неудачи — люди успевали на него наткнуться.
        AND s.status = 'alive'
         -- Российский вердикт важнее: узел, который не открывается
         -- у оператора в РФ, не должен висеть в списке только потому,
         -- что он жив для раннера в США.
         AND (s.ru_dead_at IS NULL OR s.ru_dead_at < datetime('now','-48 hours'))
         -- Страны, которые не работают у оператора: исключены совсем,
         -- а не на 48 часов, как российский вердикт. Список правится здесь.
         AND (s.country_code IS NULL OR s.country_code NOT IN ('JP','US','NL','BG','NO','CH'))
        -- Без страны узел выглядит в клиенте как голый домен: «freetg.ghost-
        -- service.cc · VLESS». Такие в выдачу не пускаем.
        AND s.country_code IS NOT NULL
        AND s.country_code <> ''
         -- Владельцу отдаём и приватные источники (его платные подписки):
         -- ключи лежат в его же базе, поэтому не зависят от чужого сервиса.
         -- Остальным — только публичные: приватное не должно утекать.
         ${owner ? "" : "AND src.visibility = 'shareable'"}
         AND (src.share_until IS NULL OR src.share_until > datetime('now'))
         -- Премиум-источник в общий пул не пускаем: там лежат и старые
         -- импорты с ничего не говорящим именем «Премиум сервер». В выдачу
         -- они попадают отдельной выборкой по tier='premium' с флагом и
         -- страной, поэтому дублей и безымянных строк больше не будет.
         AND src.name NOT LIKE '%Премиум%'
       -- Свежесть важнее абсолютной скорости: узлы, проверенные за последние
       -- сутки, идут первыми, остальные добирают остаток списка. Так состав
       -- сам обновляется по мере обхода очереди, но пул не может опустеть,
       -- если проверки на день встали: старые узлы остаются в резерве.
        -- Приоритет стран вместо абсолютного порога пинга: ближние к РФ
        -- выходы стабильнее по маршруту, даже если формально медленнее.
          -- Свежесть — первый ключ сортировки. Раньше она упоминалась только
          -- в комментарии, а список начинался с узлов, проверенных сутки
          -- назад: они могли уже не работать, и именно на них попадал
          -- человек, выбирая верхнюю строку.
          ORDER BY (s.verified_at >= datetime('now','-24 hours')) DESC,
                   -- Для РФ: сначала соседние страны. Из Латвии, Литвы,
                   -- Польши и Германии у местных операторов обычно ниже
                   -- задержка и меньше блокировок, чем из США или Азии.
                   CASE WHEN s.country_code IN ('LV','LT','EE','PL','DE','FI','SE','FR','CZ','SK','KZ','AM','GE','TR','RS','MD') THEN 0 ELSE 1 END,
                   -- Для РФ: сначала соседние страны. Из Латвии, Литвы,
                   -- Польши и Германии у местных операторов обычно ниже
                   -- задержка и меньше блокировок, чем из США или Азии.
                   CASE WHEN s.country_code IN ('LV','LT','EE','PL','DE','FI','SE','FR','CZ','SK','KZ','AM','GE','TR','RS','MD') THEN 0 ELSE 1 END,
                   (s.blocked_ok = 1) DESC,
                  -- Быстрые узлы впереди медленных: мягкий потолок не должен
                  -- пускать 800-миллисекундные в начало списка.
                  (s.verified_latency_ms <= 600) DESC,
                  -- Сначала узлы тех же семейств, что уже работают в подписке:
                  -- один провайдер обычно держит одинаковое качество каналов,
                  -- и такой узел предсказуемее случайного.
                  CASE
                    WHEN s.host LIKE '%eclapp.net%' THEN 0
                    WHEN s.host LIKE '%pythonmakemigreat.wiki%' THEN 0
                    WHEN s.host LIKE '%dropstyle.lol%' THEN 0
                    WHEN s.host LIKE '%eclvps.com%' THEN 1
                    ELSE 2
                  END,
                  CASE
                    WHEN s.country_code IN ('FI','SE','EE','LV','LT','PL','DE','NL') THEN 0
                   WHEN s.country_code IN ('FR','AT','CZ','SK','HU','RO','BG','GR','IT','ES','PT','BE','DK','NO','CH','IE','SI','HR','RS','UA','MD','GB','IS','LU','MT','CY') THEN 1
                   ELSE 2
                 END,
                 s.verified_latency_ms ASC,
                 COALESCE(s.speed_mbps, 0) DESC
        LIMIT 90`,
    );
  } catch (error) {
    // Исчерпанная квота D1 не должна превращаться в «нет серверов»:
    // отдаём последний собранный пул, он проверен и рабочий.
    if (cached && cached.length) return cached;
    throw error;
  }
  // Российские выходы не выбрасываем, а ставим в конец. Раньше они отсекались
  // целиком, если был хоть один зарубежный узел — а в тонком пуле именно
  // RU-узел часто единственный рабочий. Проверка blocked_ok=1 уже доказывает,
  // что он обходит блокировки.
  const final = [...rows].sort((a, b) => Number(isRussian(a)) - Number(isRussian(b)));

  // Один и тот же сервер приходит из двух ключей одного провайдера: UUID
  // разные, адрес один. Оставляем тот, что выше в сортировке, иначе в списке
  // два одинаковых флага подряд и человек выбирает вслепую.
  const byEndpoint = new Set<string>();
  const deduped: DeliverableServer[] = [];
  for (const row of final) {
    const key = `${row.host}:${row.port}`;
    if (byEndpoint.has(key)) continue;
    byEndpoint.add(key);
    deduped.push(row);
  }

  // Не больше четырёх узлов с одного хоста: иначе один щедрый источник
  // Р·Р°РЅРёРјР°РµС‚ РїРѕР»СЃРїРёСЃРєР°, Рё РїСЂРё РµРіРѕ РїР°РґРµРЅРёРё РїСЂРѕРїР°РґР°РµС‚ РІСЃС‘ СЂР°Р·РѕРј. РСЃРєР»СЋС‡РµРЅРёРµ вЂ”
  // разные страны на одном хосте: это geo-entry с портом под каждую страну
  // (eclvpn держит так GB/TR/CN/AE/BY), и пятый порт не должен пропадать.
  const perHost = new Map<string, number>();
  const hostCountries = new Map<string, Set<string>>();
  const capped: DeliverableServer[] = [];
  for (const row of deduped) {
    const used = perHost.get(row.host) ?? 0;
    const countries = hostCountries.get(row.host) ?? new Set<string>();
    const country = String(row.country_code ?? "");
    const newCountryForHost = country !== "" && !countries.has(country);
    const allowed = used < 4 || (used < 8 && newCountryForHost);
    if (!allowed) continue;
    perHost.set(row.host, used + 1);
    if (country) countries.add(country);
    hostCountries.set(row.host, countries);
    capped.push(row);
    if (capped.length >= 60) break;
  }

  // Мягкая деградация вместо аварийного снимка. Раньше при менее чем пяти
  // узлах бросалось исключение, и человек получал замороженный старый список:
  // состав не обновлялся, метки не появлялись, а причину видно только в логах.
  // Теперь добираем узлы из более широкого окна — лучше чуть менее свежий
  // рабочий узел, чем снимок недельной давности.
  let picked = capped;
  if (picked.length < 5) {
    let relaxed: DeliverableServer[] = [];
    try {
      relaxed = await many<DeliverableServer>(
        env,
      `SELECT ${SERVER_COLUMNS}, 0 AS stability
         FROM servers s
         JOIN sources src ON src.id = s.source_id
        WHERE s.verified_latency_ms > 0
          AND s.verified_at >= datetime('now','-72 hours')
          AND s.verified_latency_ms <= 1100
          AND s.status IN ('alive','unknown')
          -- blocked_ok = 0 значит «узел проверен и не открывает Telegram»:
          -- такому в подписке не место, даже как запасному.
          AND (s.blocked_ok IS NULL OR s.blocked_ok <> 0)
          AND s.enabled = 1
          AND s.country_code IS NOT NULL AND s.country_code <> ''
          AND src.visibility = 'shareable'
          AND (src.share_until IS NULL OR src.share_until > datetime('now'))
          AND src.name NOT LIKE '%Премиум%'
        ORDER BY s.verified_latency_ms ASC
        LIMIT 40`,
    );
    } catch {
      // без добора: короткий список лучше исключения
    }
    const seenRelaxed = new Set<string>();
    const extra: DeliverableServer[] = [];
    for (const row of relaxed) {
      const key = `${row.host}:${row.port}`;
      if (seenRelaxed.has(key)) continue;
      if (picked.some((p) => `${p.host}:${p.port}` === key)) continue;
      seenRelaxed.add(key);
      extra.push(row);
      if (picked.length + extra.length >= 10) break;
    }
    picked = [...picked, ...extra.sort((a, b) => (a.verified_latency_ms ?? 1e9) - (b.verified_latency_ms ?? 1e9))];
  }

  // Третий рубеж: узлы, которые уже хоть раз проходили туннель (есть exit_ip),
  // но проверка устарела. Свежесть важнее, но список из семи узлов, половина
  // которых успела умереть, хуже, чем двадцать с запасом: человек листает
  // и находит рабочий, а автовыбор всё равно берёт закреплённые сверху.
  if (picked.length < 12) {
    const proven = await many<DeliverableServer>(
      env,
      `SELECT ${SERVER_COLUMNS}, 0 AS stability
         FROM servers s
         JOIN sources src ON src.id = s.source_id
        WHERE s.enabled = 1
          AND s.status = 'alive'
          AND s.exit_ip IS NOT NULL AND s.exit_ip <> ''
          AND (s.blocked_ok IS NULL OR s.blocked_ok <> 0)
          AND s.country_code IS NOT NULL AND s.country_code <> ''
          AND src.visibility = 'shareable'
          AND (src.share_until IS NULL OR src.share_until > datetime('now'))
          AND src.name NOT LIKE '%Премиум%'
          AND lower(s.link) LIKE '%security=reality%'
        ORDER BY (s.verified_latency_ms > 0) DESC, s.verified_latency_ms, s.id
        LIMIT 40`,
    );
    const seenProven = new Set(picked.map((p) => `${p.host}:${p.port}`));
    for (const row of proven) {
      const key = `${row.host}:${row.port}`;
      if (seenProven.has(key)) continue;
      if (!isModern(row) || isPlaceholder(row)) continue;
      seenProven.add(key);
      picked.push(row);
      if (picked.length >= 16) break;
    }
  }

  // Совсем пусто — берём живые узлы без туннель-проверки. Лучше показать
  // кандидата, чем вчерашний снимок с мёртвыми: человек сможет переключиться,
  // а не будет сутки смотреть на нерабочий список.
  if (picked.length === 0) {
    const alive = await many<DeliverableServer>(
      env,
      `SELECT ${SERVER_COLUMNS}, 0 AS stability
         FROM servers s
         JOIN sources src ON src.id = s.source_id
        WHERE s.enabled = 1
          AND s.status IN ('alive','unknown')
          AND (s.blocked_ok IS NULL OR s.blocked_ok <> 0)
          AND s.country_code IS NOT NULL AND s.country_code <> ''
          AND src.visibility = 'shareable'
          AND (src.share_until IS NULL OR src.share_until > datetime('now'))
          AND src.name NOT LIKE '%Премиум%'
          AND lower(s.link) LIKE '%security=reality%'
        ORDER BY s.latency_ms IS NULL, s.latency_ms, s.id
        LIMIT 20`,
    );
    picked = alive
      .filter(isModern)
      .sort((a, b) => Number(isRussian(a)) - Number(isRussian(b)))
      .slice(0, 10);
  }

  // Совсем пусто — вот тут снимок уместнее пустоты.
  if (picked.length === 0) {
    throw new Error(`нет ни одного узла (rows=${rows.length} final=${final.length})`);
  }
  const cappedFinal = picked;

  // Премиум: приватный источник в общий снимок не попадает, поэтому
  // добираем его отдельно и склеиваем — но только для владельца и
  // пользователей с тарифом premium.
  // Берём именно capped, а не final: иначе весь смысл дедупликации по
  // endpoint и лимита «четыре с хоста» теряется — наружу уходит сырой список.
  let base = cappedFinal;
  if (premium) {
    // Владельцу отдаём и личные узлы (локальный снимок платной подписки),
    // остальным — только tier='premium'. Иначе чужие платные ключи разошлись
    // бы по всей подписке, а провайдер банит их за перегрузку.
    const tiers = owner ? "'premium','personal'" : "'premium'";
    const extra = await many<DeliverableServer>(
      env,
      `SELECT ${SERVER_COLUMNS}, 0 AS stability
         FROM servers s
         JOIN sources src ON src.id = s.source_id
        WHERE s.tier IN (${tiers})
          AND s.enabled = 1
          -- Личные и премиум-узлы проходят ТУ ЖЕ проверку, что и общий пул:
          -- иначе в подписку попадали все импортированные узлы скопом,
          -- включая давно мёртвые.
          AND s.verified_latency_ms > 0
          AND s.verified_at >= datetime('now','-72 hours')
          AND s.status = 'alive'
          AND (
            s.verified_latency_ms <= 800
            OR (src.name LIKE 'ECL%' AND s.verified_latency_ms <= 1100)
            OR (s.tier = 'personal' AND s.verified_latency_ms <= 1500)
          )
          AND (s.blocked_ok = 1 OR s.blocked_probe LIKE '%tg:ok%')
          -- Узел без страны в списке выглядит как «Премиум · 1.2.3.4», а
          -- старые импорты Astra вообще шли без гео. Показываем только те,
          -- у кого страна определена: иначе человек не понимает, что выбрать.
          AND s.country_code IS NOT NULL
          AND s.country_code <> ''
        ORDER BY s.verified_latency_ms ASC
        LIMIT 80`,
    );
    base = [...extra, ...cappedFinal];
  }

  // Спасательный пул. Когда база недоступна, узлы проверяются вручную и
  // складываются в KV. Без этой подмешки первый же успешный прогон синка
  // пересобрал бы подписку из базы — то есть вернул мёртвый список.
  // Записи живут 48 часов: дальше либо узел попадёт в базу обычной проверкой,
  // либо уйдёт — держать непроверенное дольше нельзя.
  try {
    const rescue = await env.CACHE.get<DeliverableServer[]>("pool:rescue:v1", "json");
    if (rescue && rescue.length) base = [...rescue, ...base];
  } catch {
    // KV недоступен — обходимся базой
  }

  // Один и тот же узел приходит и из пула, и из премиум-выборки: режем
  // повторы здесь, до кэширования, иначе они размножаются в снимке.
  const seen = new Set<string>();
  const unique = base.filter((row) => {
    const k = nodeKey(row);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (unique.length) {
    await env.CACHE.put(key, JSON.stringify(unique), { expirationTtl: POOL_TTL });
  }
  return unique;
}

/**
 * Снимок пула «Белые списки» — второй тип обхода DPI (режим byedpi).
 *
 * Эти узлы идут отдельно от основного REALITY-пула: они проверяются на
 * доступность белых доменов (магазины, госуслуги), а не на туннель через
 * Telegram, поэтому у них нет verified_latency_ms. Отбираем живые/неизвестные
 * с определённой страной, без CDN-хостов и без мусорных подписей.
 */
export function looksWhitelisted(row: DeliverableServer): boolean {
  const link = row.link ?? "";
  if (!/security=(reality|tls)/i.test(link)) return false;
  if (![443, 8443].includes(Number(row.port))) return false;
  const host = row.host ?? "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return host.includes(".") && /[a-z]/i.test(host);
}

export async function loadWhitelistPool(env: Env, fresh = false): Promise<DeliverableServer[]> {
  // В режиме «только присланные ключи» белый список — их же подмножество на 443.
  try {
    const only = await env.CACHE.get<DeliverableServer[]>("pool:rescue:v1", "json");
    if (only && only.length) {
      return only.filter((row) => [443, 8443].includes(Number(row.port)));
    }
  } catch {
    // идём обычным путём
  }

  // Кэш читаем всегда: при недоступной базе он единственный источник узлов.
  const cached = await env.CACHE.get<DeliverableServer[]>(POOL_KEY_WHITELIST, "json");
  if (cached && cached.length && !fresh) return cached;

  let rows: DeliverableServer[];
  try {
    rows = await many<DeliverableServer>(
    env,
    `SELECT ${SERVER_COLUMNS}, 0 AS stability
       FROM servers s
       JOIN sources src ON src.id = s.source_id
       JOIN pool_servers ps ON ps.server_id = s.id
      WHERE ps.pool_id = 3
        AND s.enabled = 1
        -- «Белый список» — второй тип обхода, но правило живости то же:
        -- узел обязан хоть раз пройти настоящую проверку. Раньше здесь
        -- допускался status='unknown', то есть узел, который проверку уже
        -- провалил, — и в подписке висели мёртвые строки с этой меткой.
        AND s.status = 'alive'
        AND (
          s.verified_latency_ms > 0
          OR (s.exit_ip IS NOT NULL AND s.exit_ip <> '')
        )
        AND s.country_code IS NOT NULL AND s.country_code <> ''
        AND src.visibility = 'shareable'
        AND (src.share_until IS NULL OR src.share_until > datetime('now'))
      ORDER BY s.status = 'alive' DESC, s.latency_ms IS NULL, s.latency_ms, s.id
      LIMIT 80`,
    );
  } catch {
    // База недоступна — отдаём то, что уже лежит в KV.
    return cached ?? [];
  }

  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    if (!isModern(row)) return false;
    if (isPlaceholder(row)) return false;
    const k = nodeKey(row);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (unique.length) {
    await env.CACHE.put(POOL_KEY_WHITELIST, JSON.stringify(unique), { expirationTtl: POOL_TTL });
  }
  return unique;
}

/**
 * Отпечаток узла. Хоста и порта мало: у Astra на одном адресе висят разные
 * конфигурации, различающиеся uuid и путём. Берём хвост ссылки, а если
 * разобрать не удалось — пару host:port.
 */
function nodeKey(row: DeliverableServer): string {
  const link = row.link ?? "";
  const at = link.indexOf("@");
  const query = link.indexOf("?");
  if (at > 0 && query > at) {
    const id = link.slice(link.indexOf("://") + 3, at);
    const tail = link.slice(query).replace(/#.*$/, "");
    return `${id}${tail}`;
  }
  return `${row.host}:${row.port}`;
}

/**
 * Имя узла от провайдера в человеческий вид.
 *
 * Платные подписки подписывают серверы рекламой и служебными пометками:
 * «🇫🇮 Финляндия ⚡ быстрый», «Stockholm ^~2~^», «Warsaw #2». Наша подписка
 * сама добавляет «⚡ быстрый» и номер клона, поэтому такие хвосты нужно
 * снять — иначе в клиенте видно «⚡ быстрый · 🎮 · ⚡ быстрый».
 */
function cleanOwnRemark(value: string): string {
  return value
    .replace(/⚡\s*быстрый\s*\d*/gi, " ")
    .replace(/\^~[^~]*~\^/g, " ")
    .replace(/\s*#\d+\s*/g, " ")
    // Служебные слова провайдера не должны попадать в имя узла: «Казахстан
    // новый» ничего не говорит о сервере.
    .replace(/(?:^|\s)(новый|нейронки|игровой|gRPC|5G|TG,YT,INST)(?=\s|$)/gi, " ")
    .replace(/^[\s·\-]+|[\s·\-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Сбросить снимок: после новых проверок он устарел. */
export async function invalidatePool(env: Env): Promise<void> {
  // Оба ключа: премиум-снимок собирается отдельно, и если сбросить только
  // общий, премиум-пользователи продолжат получать старый состав.
  await Promise.all([
    env.CACHE.delete(POOL_KEY),
    env.CACHE.delete(POOL_KEY_PREMIUM),
    env.CACHE.delete(POOL_KEY_OWNER),
    env.CACHE.delete(POOL_KEY_WHITELIST),
  ]);
}

/**
 * Прямой резерв подписки: список проверенных вручную ссылок в KV.
 *
 * Зачем: пул собирается из D1, а у бесплатного тарифа есть суточный лимит
 * чтений. Когда он исчерпан, пул пустеет и люди получают заглушку, хотя
 * рабочие узлы известны. Эти ссылки не читают базу вообще.
 */
/**
 * Схемы, которые принимаем из прямого резерва. Не только VLESS: Hysteria2 и
 * родственные протоколы нужны как раз тогда, когда TCP-узлы у оператора
 * режутся, а QUIC проходит.
 */
const DIRECT_LINK_RE =
  /^(vless|vmess|trojan|ss|ssr|hysteria2|hy2|hysteria|tuic|anytls):\/\//i;

async function appendDirectLinks(env: Env, uris: string[]): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await env.CACHE.get("direct:links");
  } catch {
    return;
  }
  if (!raw) return;

  const endpoint = (link: string): string => {
    try {
      const body = link.slice(link.indexOf("://") + 3).split("#")[0];
      const hostPort = body.split("@").pop()?.split("?")[0] ?? "";
      return hostPort.toLowerCase();
    } catch {
      return "";
    }
  };

  const existing = new Set(uris.map(endpoint));
  const verified: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const link = line.trim();
    if (!DIRECT_LINK_RE.test(link)) continue;
    const key = endpoint(link);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    let label = "Прямой резерв";
    const fragment = link.split("#")[1];
    if (fragment) {
      try {
        const decoded = decodeURIComponent(fragment).trim();
        if (decoded) label = decoded;
      } catch {
        // битая метка не должна ломать выдачу
      }
    }
    verified.push(withLabel(cleanLink(link), `${label} · ✅ проверено`));
  }
  // Проверенные вручную узлы ставим в начало списка. Клиент по умолчанию
  // подключается к первой строке, а узел из пула мог «протухнуть»: проверка
  // шла из другой сети, и у оператора он уже не открывается.
  if (verified.length > 0) uris.unshift(...verified);
}

export async function handleSubscription(
  env: Env,
  token: string,
  request: Request,
  mode: SubMode = "default",
): Promise<Response> {
  try {
    return await serveSubscription(env, token, request, mode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("subscription failed", message);
    // trim: секрет, залитый из PowerShell, приходит с переводом строки.
    if (String(env.SUB_DEBUG ?? "").trim() === "1") {
      const stack =
        error instanceof Error ? (error.stack ?? "").slice(0, 700) : "";
      return new Response(`SUB ERR: ${message}\n${stack}`, { status: 500 });
    }
    // Последняя удачная выдача вместо заглушки. У человека в клиенте уже
    // есть рабочий список серверов; подменить его на «127.0.0.1:1» хуже,
    // чем отдать тот же список ещё раз.
    const rescued = await fallbackBody(env, mode);
    if (rescued) {
      // JSON-режимы должны оставаться JSON даже в резерве: клиент, который
      // ждёт конфиг Xray/sing-box, base64-список не разберёт.
      const presented = rescuePresentation(env, mode, rescued);
      if (presented) return presented;
      return plain(env, rescued, null, null);
    }
    return plain(env, stubBody(overloadText()), null, null);
  }
}

/** Ссылки из base64-тела подписки. */
function bodyUris(body: string): string[] {
  let text = body;
  try {
    text = atob(body);
  } catch {
    // тело уже текстом
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[a-z0-9]+:\/\//i.test(line));
}

/**
 * Резервный JSON для режимов auto/sb. Без этого при сбое базы клиент
 * получает base64-список и не показывает «Автоматический выбор».
 */
function rescuePresentation(
  env: Env,
  mode: SubMode,
  body: string,
): Response | null {
  if (mode !== "auto" && mode !== "sb") return null;
  const uris = bodyUris(body);
  if (uris.length === 0) return null;
  // Xray-JSON умеет только VLESS: если в резерве одни Hysteria2, честнее
  // отдать список ссылок, чем конфиг без единого прокси.
  if (mode === "auto" && !uris.some((uri) => /^vless:\/\//i.test(uri))) return null;
  const config =
    mode === "sb"
      ? buildSingBoxConfig(uris, uris.length)
      : buildAutoConfig(uris, uris.length);
  if (!config) return null;
  return autoResponse(env, config, null, null);
}

/**
 * Резервная выдача, когда собрать подписку не удалось.
 *
 * Сначала снимок запрошенного режима, затем обычной подписки. Любой из них
 * лучше заглушки: клиент сохранит рабочие узлы и продолжит пускать трафик,
 * а следующий запрос через час попробует собрать свежий список заново.
 */
async function fallbackBody(env: Env, mode: SubMode): Promise<string | null> {
  // Персональный срез не храним: у всех один и тот же пул, а лишняя запись
  // в KV упирается в суточные 1000 операций.
  const keys = [`snapshot:${mode}`, "snapshot:default"];
  for (const key of keys) {
    try {
      const body = await env.CACHE.get(key);
      if (body) return await cleanFallback(env, body);
    } catch {
      // KV может быть недоступен целиком — тогда пробуем следующий ключ.
    }
  }
  return null;
}

/**
 * Чистим аварийный снимок: убираем узлы из KNOWN_DEAD_HOSTS и добавляем
 * прямой резерв из KV. Снимок мог быть записан до того, как узел умер, а
 * «Connected без интернета» хуже, чем короткий список.
 */
async function cleanFallback(env: Env, body: string): Promise<string> {
  let text: string;
  try {
    text = atob(body);
  } catch {
    return body;
  }
  if (!text.includes("://")) return body;

  const dead = (link: string): boolean => {
    try {
      const rest = link.slice(link.indexOf("://") + 3).split("#")[0];
      const hostPort = rest.split("@").pop()?.split("?")[0] ?? "";
      const host = hostPort.replace(/:\d+$/, "").toLowerCase();
      return KNOWN_DEAD_HOSTS.has(host);
    } catch {
      return false;
    }
  };

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !(line.startsWith("vless://") && dead(line)));

  const seen = new Set(
    lines.map((line) => {
      const rest = line.slice(line.indexOf("://") + 3).split("#")[0];
      return (rest.split("@").pop()?.split("?")[0] ?? "").toLowerCase();
    }),
  );
  try {
    const direct = await env.CACHE.get("direct:links");
    if (direct) {
      for (const raw of direct.split(/\r?\n/)) {
        const link = raw.trim();
        if (!DIRECT_LINK_RE.test(link)) continue;
        const rest = link.slice(link.indexOf("://") + 3).split("#")[0];
        const key = (rest.split("@").pop()?.split("?")[0] ?? "").toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        lines.push(link);
      }
    }
  } catch {
    // без резерва снимок всё равно лучше заглушки
  }

  // Якоря нужны и в аварийном снимке: он мог быть записан до того, как
  // ссылки закрепили, и без этого человек при сбое их не увидит.
  const anchored = new Set(PINNED_LINKS.map((pin) => endpointOfLink(pin.link)));
  return btoa(
    PINNED_LINKS.map((pin) => withLabel(cleanLink(pin.link), pin.label))
      .concat(lines.filter((line) => !anchored.has(endpointOfLink(line))))
      .join("\n") + "\n",
  );
}

/**
 * Честный срок вместо «попробуйте через 10 минут»: суточная квота D1
 * сбрасывается в 00:00 UTC, раньше база не оживёт.
 */
function overloadText(): string {
  const now = Date.now();
  const today = new Date(now);
  const reset = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate() + 1,
  );
  const hours = Math.max(1, Math.ceil((reset - now) / 3_600_000));
  return `База перегружена: исчерпан суточный лимит. Доступ восстановится автоматически после 00:00 UTC, примерно через ${hours} ч`;
}

async function serveSubscription(
  env: Env,
  token: string,
  request: Request,
  mode: SubMode = "default",
): Promise<Response> {
  const ip = clientIp(request);
  // 60 запросов в минуту с одного адреса — защита от перебора токенов
  if (!memRateLimit(`sub:${ip}`, 60, 60)) {
    return new Response("Слишком много запросов", { status: 429 });
  }
  if (!token || token.length < 20) {
    return new Response("Не найдено", { status: 404 });
  }

  // Пользователь ищется в базе, но падение базы не должно убивать подписку.
  // Раньше здесь стоял обычный SELECT: при исчерпанной квоте D1 он бросал
  // исключение, обработчик уходил в аварийный снимок, и человек неделю видел
  // один и тот же мёртвый список, хотя свежий пул уже лежал в KV.
  const userKey = `user:${token}`;
  let user: UserRow | null = null;
  try {
    user = await one<UserRow>(
      env,
      "SELECT * FROM users WHERE sub_token = ?",
      token,
    );
  } catch {
    user = null;
  }
  if (user) {
    // Держим копию строки в KV: она и выручает, когда база недоступна.
    try {
      await env.CACHE.put(userKey, JSON.stringify(user), {
        expirationTtl: 7 * 24 * 3600,
      });
    } catch {
      // KV тоже может быть недоступен — тогда работаем без копии.
    }
  } else {
    try {
      user = await env.CACHE.get<UserRow>(userKey, "json");
    } catch {
      user = null;
    }
  }
  // сравнение за постоянное время уже после выборки
  if (!user || !timingSafeEqual(user.sub_token, token)) {
    return plain(env, stubBody("Подписка не найдена — напишите боту"), null, null);
  }

  const blocked = timedOutStatus(user);
  if (blocked) {
    return plain(env, stubBody(blocked), null, user);
  }

  // Присутствие: откуда пришёл запрос — из туннеля или напрямую.
  // Пишем один UPSERT, он сам себя тормозит до раза в две минуты.
  // Служебные записи не должны ронять выдачу: при недоступной базе подписка
  // обязана собираться, а статистика присутствия — дело десятое.
  try {
    const snap = await snapshot(env, request);
    await recordPresence(env, user.id, snap, "sub");
  } catch {
    // без статистики
  }

  // Устройство могли отвязать вручную — тогда именно ему отдаём отказ.
  let device: Awaited<ReturnType<typeof touchDevice>> = null;
  try {
    device = await touchDevice(env, user.id, request.headers.get("User-Agent") ?? "");
  } catch {
    device = null;
  }
  if (device?.blocked) {
    return plain(
      env,
      stubBody("Это устройство отключено. Откройте бота → «📱 Устройства»"),
      null,
      user,
    );
  }

  // Кэшируем только основную подписку: у режимов своя фильтрация,
  // и держать шесть копий тела в KV дороже, чем собрать заново.
  // v4: сменился порядок сортировки (проверенные наверх) — старый кэш мимо.
  // Режим обязан быть в ключе: игровой профиль и профили по протоколу пишут в
  // тот же KV, и без mode они затирали основную подписку своим коротким списком.
  // Ротация запасной части списка. Эпоха — номер 15-минутного отрезка:
  // одинаковая у всех нод и клиентов, поэтому после кэша состав совпадает.
  const epoch = Math.floor(Date.now() / (ROTATION_MINUTES * 60_000));

  // Кэшируем обычную выдачу и byedpi: обе собираются из KV-снимков, и без
  // кэша каждое обновление в Happ шло бы в D1. Остальные режимы — редкие,
  // собираются на лету.
  const cacheable = mode === "default" || mode === "byedpi";
  // Штамп пула обновляется после каждой пачки проверок. Без него тело жило
  // до смены эпохи (15 минут), и мёртвый узел, уже найденный проверкой,
  // продолжал висеть у человека в списке.
  const poolStamp = cacheable ? ((await env.CACHE.get("pool:stamp")) ?? "0") : "0";
  const cacheKey = `sub:v100:${mode}:${epoch}:${poolStamp}:${token}`;
  const cached = cacheable ? await env.CACHE.get(cacheKey) : null;
  if (cached) {
    const parsed = JSON.parse(cached) as { body: string };
    // Заголовок считаем заново из БД: в кэше он устаревает и Happ
    // показывает «безлимит», если срок или лимит поменяли.
    let info: string | null = null;
    try {
      info = await buildUserinfo(env, user);
    } catch {
      info = null;
    }
    return plain(env, parsed.body, info, user);
  }

  // Платные и приватные источники видит только админ — «моя подписка».
  const isAdmin = String(user.tg_id) === envStr(env.ADMIN_TG_ID);
  const strict = isStrictDefault(env);
  // В строгом режиме стабильность не нужна: работа определяется проверкой,
  // а подзапрос по истории стоит сотни строк чтения D1 на каждую выдачу.
  const sql = strict && mode === "default" ? SERVER_SQL_LIGHT : SERVER_SQL;
  // Горячий путь: строгий режим и обычная выдача. Берём снимок из KV,
  // D1 трогаем только когда снимка нет или он протух.
  // РРіСЂРѕРІРѕР№ РїСЂРѕС„РёР»СЊ С‚РѕР¶Рµ СЃРѕР±РёСЂР°РµС‚СЃСЏ РёР· РѕР±С‰РµРіРѕ РїСѓР»Р°: РёРЅР°С‡Рµ РѕРЅ РѕРіСЂР°РЅРёС‡РёРІР°Р»СЃСЏ
  // персональными назначениями, у людей без назначений список выходил короче,
  // и «одинаковые серверы» ломались.
  // Одинаковый список у всех.
  //
  // В строгом режиме выдача и так собирается из общего пула, а не из
  // персональных назначений — проверил на шести подписках, наборы совпадают
  // до последнего адреса. Но это держалось на побочном условии: выключи
  // STRICT_WORKING — и каждый снова начнёт получать свой набор. Флаг
  // SHARED_LIST делает равенство явным и не зависит от строгого режима.
  const sharedList = (env.SHARED_LIST ?? "1") !== "0";
  const usePool = (strict || sharedList) && mode === "default";
  let rows: DeliverableServer[];
  // Режим byedpi питается только из пула «Белые списки»: назначения и
  // основной verified-пул тут не участвуют, иначе второй профиль
  // дублировал бы первый.
  if (mode === "byedpi") {
    rows = await loadWhitelistPool(env, isAdmin);
  } else {
    rows = usePool
      ? await loadPool(
          env,
          isAdmin || ["premium", "personal"].includes(user.tier ?? ""),
          isAdmin,
          isAdmin,
        )
      : await many<DeliverableServer>(env, sql, user.id, isAdmin ? 1 : 0);
  }
  // Премиум: узлы подтверждены владельцем в клиенте, но не нашим тестом.
  // РР· РїСѓР»Р° РѕРЅРё СѓР¶Рµ РїСЂРёС€Р»Рё (loadPool РґРѕР±Р°РІР»СЏРµС‚ РёС… РґР»СЏ РїСЂРµРјРёСѓРј-С‚Р°СЂРёС„Р°),
  // поэтому добираем отдельным запросом только на непуловом пути —
  // иначе каждый узел попадал в выдачу дважды.
  if (mode !== "byedpi" && !usePool && (isAdmin || (user.tier ?? "") === "premium")) {
    const premiumRows = await many<DeliverableServer>(
      env,
      `SELECT ${SERVER_COLUMNS}, 0 AS stability
         FROM servers s
         JOIN sources src ON src.id = s.source_id
        WHERE s.tier = 'premium'
          AND s.enabled = 1
          AND s.country_code IS NOT NULL
          AND s.country_code <> ''
        ORDER BY s.id
        LIMIT 40`,
    );
    if (premiumRows.length) rows = [...premiumRows, ...rows];
  }

  // Российские выходы не отсекаем: узел, прошедший проверку через туннель,
  // работает независимо от того, где он стоит. Раньше весь RU-слой
  // выбрасывался, и единственный быстрый живой узел (378 мс, Telegram и
  // YouTube открываются) не попадал в подписку вообще. Порядок решает
  // сортировка ниже: RU-узлы идут в конце.
  let deliverable = rows.filter(
    (row) =>
      isDeliverable(row, isAdmin) ||
      (row.tier === "premium" && (user.tier ?? "") === "premium"),
  );

  // Самовосстановление: серверы есть, а человеку ничего не выдано — выдаём сейчас.
  // Режим byedpi исключён: там свои узлы из пула, назначения не при чём.
  if (mode !== "byedpi" && !usePool && deliverable.length === 0) {
    const issued = await assignIfEmpty(env, user.id, Number(env.SERVERS_PER_USER ?? "3"));
    if (issued > 0) {
      rows = await many<DeliverableServer>(env, sql, user.id, isAdmin ? 1 : 0);
      deliverable = rows.filter(
        (row) =>
          isDeliverable(row, isAdmin) ||
          (row.tier === "premium" && (user.tier ?? "") === "premium"),
      );
    }
  }

  // Только то, что реально пробивает блокировки, и лучшее — вверх.
  // Тарифные категории: personal — только владельцу, free/premium — по тарифу.
  const userTier = isAdmin ? "personal" : (user.tier ?? "free");
  deliverable = deliverable
    .filter((server) => !isPlaceholder(server))
    .filter((server) => server.enabled !== 0)
    .filter((server) => {
      const tier = server.tier ?? "free";
      if (tier === "personal") return isAdmin;
      if (userTier === "premium" || isAdmin) return true;
      return tier === "free";
    })
    .filter(isModern)
    .sort(compareServers)
    // Стабильная перестановка: зарубежные остаются в порядке compareServers,
    // российские уезжают в конец списка (а не исчезают из него).
    .sort((a, b) => Number(isRussian(a)) - Number(isRussian(b)));

  // По умолчанию в подписке только то, что реально прошло через туннель.
  // РРЅР°С‡Рµ С‡РµР»РѕРІРµРє РІРёРґРёС‚ СЃРїРёСЃРѕРє РёР· РјС‘СЂС‚РІС‹С… СѓР·Р»РѕРІ Рё СЃС‡РёС‚Р°РµС‚, С‡С‚Рѕ В«VPN РЅРµ СЂР°Р±РѕС‚Р°РµС‚В».
  // Проверка живости нужна всегда, а не только в строгом режиме. Раньше при
  // выключенной строгости в список попадали узлы, у которых проверка уже
  // провалилась, — человек тыкал в них и решал, что VPN сломан.
  // Фильтр применяется на любом пути — и через пул, и через назначения.
  // Раньше он стоял только под условием строгого режима, и при выключенной
  // строгости в подписку пролезали провалившие проверку узлы и строки без
  // страны, которые в клиенте выглядят как голый домен.
  deliverable = deliverable.filter((server) => {
    const country = String(server.country_code ?? "").trim();
    // Узел без гео показывается доменом вместо «страны · города», но это
    // лучше, чем потерять единственный живой сервер: проверка через туннель
    // уже доказала, что он работает. Гео дозаполняет tools/geo_fill.py.
    if (!country && !isWorkingServer(server, 72 * 60 * 60 * 1000)) return false;
    // Режим byedpi: узлы «белых списков» проверяются на доступность белых
    // доменов, а не через туннель — verified_latency_ms у них нет. Требуем
    // только живой порт (настоящую работу покажет сам клиент).
    if (mode === "byedpi") {
      return String(server.status ?? "alive") !== "dead";
    }
    // Премиум-узлы раньше шли мимо проверки («проверены владельцем»), и в
    // автовыборе сверху висели мёртвые astra/spacessupport. Теперь правило
    // одно для всех: показываем только то, что прошло туннель за 72 часа.
    if (isWorkingServer(server, 72 * 60 * 60 * 1000)) {
      return String(server.status ?? "alive") !== "dead";
    }
    // Запас: узел уже проходил туннель (есть выходной IP), просто проверка
    // устарела. Если держать только свежие, список схлопывается до горстки
    // узлов, и когда они умирают, человек остаётся без VPN. Такие идут
    // в конце списка — свежие всё равно выше по сортировке.
    const proven = String(server.exit_ip ?? "").trim();
    // blocked_ok = 0 — узел проверен и не открывает Telegram: запасным он
    // тоже не годится, иначе «на всякий случай» в списке висят мёртвые.
    if (server.blocked_ok === 0) return false;
    return (
      proven !== "" &&
      String(server.status ?? "alive") === "alive" &&
      server.tier !== "premium"
    );
  });

  // Запасные узлы не должны заполонить список: свежих проверенных отдаём
  // все, непроверенных — не больше восьми. Человек листает короткий список,
  // а не сотню строк, половина из которых вчера умерла.
  {
    let reserve = 0;
    deliverable = deliverable.filter((server) => {
      if (isWorkingServer(server, 72 * 60 * 60 * 1000)) return true;
      reserve += 1;
      return reserve <= 8;
    });
  }

  // Режимы отбора. Всё, кроме default и byedpi, дополнительно требует
  // настоящий VLESS + REALITY с полным набором параметров.
  // РРіСЂРѕРІРѕР№ РїСЂРѕС„РёР»СЊ РЅРµ С‚СЂРµР±СѓРµС‚ REALITY: РґР»СЏ Р·Р°РґРµСЂР¶РєРё РІР°Р¶РµРЅ С‚СЂР°РЅСЃРїРѕСЂС‚, Р° РЅРµ
  // протокол маскировки, и WS/TLS узлы с малым пингом тут уместны.
  // byedpi не требует REALITY тоже: второй тип обхода работает и на WS/TLS
  // (isModern выше уже отсёл CDN и «голый» HTTP), а пул «белых списков»
  // наполовину TLS.
  if (mode !== "default" && mode !== "byedpi") {
    deliverable = deliverable.filter((server) => {
      if (!checkReality(server.link).ok) return false;
      const stability = server.stability ?? 0;
      switch (mode) {
        case "reality":
          return true;
        case "untested":
          return stability === 0 && server.latency_ms === null;
        case "working":
          return stability > 0;
        case "best":
          return stability >= 0.8;
        case "stable":
          return stability >= 0.95;
        case "low-latency":
          return (server.latency_ms ?? 0) > 0;
        default:
          return true;
      }
    });
    if (mode === "low-latency") {
      deliverable.sort((a, b) => (a.latency_ms ?? 1e9) - (b.latency_ms ?? 1e9));
    }
  }

  // Второй тип обхода (ByeDPI) — прямо в одной подписке, без отдельного
  // профиля: подмешиваем узлы пула «Белые списки» к основным. Они проверяются
  // на доступность белых доменов, а не через туннель, поэтому идут строго
  // после отобранных и с теми же бытовыми фильтрами (живой порт, страна,
  // современный протокол). Метка 📇 показывает, что это узлы второго типа.
  const whiteHosts = new Set<string>();
  if (mode === "default") {
    const existing = new Set(deliverable.map(nodeKey));
    for (const row of await loadWhitelistPool(env, isAdmin)) {
      if (row.enabled === 0) continue;
      if (String(row.status ?? "alive") === "dead") continue;
      if ((row.tier ?? "free") === "personal" && !isAdmin) continue;
      if (!String(row.country_code ?? "").trim()) continue;
      if (isRussian(row)) continue;
      if (!isModern(row)) continue;
      const k = nodeKey(row);
      if (existing.has(k)) continue;
      existing.add(k);
      whiteHosts.add(k);
      deliverable.push(row);
    }
  }

  // РРіСЂРѕРІС‹Рµ СѓР·Р»С‹ Р¶РёРІСѓС‚ РІ С‚РѕРј Р¶Рµ РїСЂРѕС„РёР»Рµ, С‡С‚Рѕ Рё РѕСЃС‚Р°Р»СЊРЅС‹Рµ: РѕС‚РґРµР»СЊРЅР°СЏ РїРѕРґРїРёСЃРєР°
  // плодит второй список в клиенте и путает. Помечаем значком 🎮 восемь самых
  // быстрых узлов с настоящим замером через туннель — по ним и видно, что
  // брать для игры.
  const gameHosts = new Set<string>(
    deliverable
      .filter((server) => server.tier !== "premium")
      .filter((server) => (server.verified_latency_ms ?? 0) > 0)
      .sort(
        (a, b) => (a.verified_latency_ms ?? 1e9) - (b.verified_latency_ms ?? 1e9) || a.id - b.id,
      )
      .slice(0, 8)
      .map((server) => `${server.host}:${server.port}`),
  );

  // Выбор пользователя важнее рейтинга: он ставится первым в списке.
  const preferredId = user.preferred_server ?? 0;
  const preferredCountry = (user.preferred_country ?? "").toUpperCase();
  if (preferredId || preferredCountry) {
    const index = deliverable.findIndex((server) =>
      preferredId ? server.id === preferredId : (server.country_code ?? "") === preferredCountry,
    );
    if (index > 0) deliverable.unshift(...deliverable.splice(index, 1));
  }

  // Один и тот же узел мог прийти и из пула, и из назначений — режем дубли
  // по отпечатку конфигурации, а не по адресу.
  const seenNodes = new Set<string>();
  deliverable = deliverable.filter((row) => {
    const k = nodeKey(row);
    if (seenNodes.has(k)) return false;
    seenNodes.add(k);
    return true;
  });

  // Платные узлы держим сверху и группируем по стране: человек покупал
  // именно их, искать «где тут премиум» в общем списке он не должен.
  // Внутри премиума — по возрастанию пинга, а не по алфавиту стран: человек
  // выбирает сервер глазами сверху вниз, и первым должен стоять самый близкий.
  const isPrem = (row: DeliverableServer) => row.tier === "premium";
  if (deliverable.some(isPrem)) {
    deliverable = [
      ...deliverable
        .filter(isPrem)
        .sort(
          (a, b) =>
            (a.latency_ms ?? 1e9) - (b.latency_ms ?? 1e9) ||
            (a.country_name ?? "яя").localeCompare(b.country_name ?? "яя", "ru") ||
            a.id - b.id,
        ),
      ...deliverable.filter((row) => !isPrem(row)),
    ];
  }

  // Ротация: премиум и самые быстрые узлы закреплены сверху (автовыбор
  // клиента всегда берёт их), остальной список перемешивается по эпохе.
  const pinnedPremium = deliverable.filter((row) => row.tier === "premium").length;
  const pinnedTotal = pinnedPremium + ROTATION_PINNED;
  deliverable = rotateTail(deliverable, epoch, pinnedTotal);

  // Узлы «белого списка» — наверх: на мобильном интернете оператор режет
  // всё остальное, и человек должен видеть рабочие строки первыми.
  const whiteTop = deliverable.filter((row) => whiteHosts.has(nodeKey(row)) || looksWhitelisted(row));
  if (whiteTop.length > 0) {
    const rest = deliverable.filter((row) => !(whiteHosts.has(nodeKey(row)) || looksWhitelisted(row)));
    deliverable = [...whiteTop, ...rest];
  }

  // «Лучший сервер» — как «Быстрейший» в платных клиентах. Клиент по
  // умолчанию подключается к первой строке, поэтому там должен стоять
  // проверенный и быстрый узел, а не случайный из ротации.
  // Ищем по всему списку, включая закреплённую верхушку: иначе «Лучшим»
  // становился первый узел ПОСЛЕ закреплённых, то есть заведомо не лучший.
  const best = pickBest(whiteTop.length > 0 ? whiteTop : deliverable, 0);
  if (best) {
    deliverable = [best, ...deliverable.filter((row) => row.id !== best.id)];
  }
  const bestId = best?.id ?? -1;

  // Убираем узлы, которые вчерашняя проверка нашла мёртвыми по данным.
  deliverable = deliverable.filter(
    (row) => !KNOWN_DEAD_HOSTS.has(String(row.host ?? "").toLowerCase()),
  );

  const uris: string[] = [];
  // Одна страна + один протокол дают одинаковые подписи, и в Happ они
  // выглядят как неразличимые клоны. Нумеруем повторы: «Россия · … · 2».
  const seenLabels = new Map<string, number>();
  deliverable.forEach((server, index) => {
    const key = parseUri(server.link);
    if (!key) return;
    const premium = server.tier === "premium";
    // Узел второго типа обхода: либо он пришёл из пула «Белые списки», либо
    // провайдер сам подписал его «Обход белых списков». Такому узлу метку
    // ставим словами и не тащим сырое имя провайдера: из него непонятно,
    // что это другой способ обхода.
    const isWhite =
      mode === "byedpi" ||
      whiteHosts.has(nodeKey(server)) ||
      looksWhitelisted(server) ||
      /обход|бел(?:ый|ых)\s*список/i.test(server.remark ?? "");
    // Имя премиум-узла собираем из страны и протокола, а не из remark:
    // в базе он общий («Премиум · сервер») и ничего не говорит о стране.
    const own = premium || isWhite
      ? ""
      : server.visibility === "private"
        ? cleanOwnRemark(server.remark ?? "")
        : "";
    const base = serverLabel(
      null,
      key,
      index + 1,
      own,
      {
        country: server.country_name,
        city: server.city,
        code: server.country_code,
      },
      server.host,
      server.verified_latency_ms,
      premium ? "Премиум" : null,
    );
    // Метка игрового узла — строго в конце имени. Happ определяет страну по
    // первому эмодзи в строке: если поставить 🎮 перед флагом, флаг перестаёт
    // распознаваться и в списке остаётся пустая иконка вместо страны.
    // Верхушка списка: вместо названия протокола — реальная скорость.
    // Протокол у закреплённых узлов одинаковый, а «12 Мбит/с» и есть то,
    // по чему человек выбирает сервер. Страна и флаг остаются первыми.
    const mbps = Number(server.speed_mbps ?? 0);
    let marked = base;
    if (index < pinnedTotal && mbps >= 5) {
      marked = base.replace(
        / · (?:VLESS|VMESS|Trojan|Shadowsocks|HY2|Node)[^·]*$/,
        ` · ⚡ ${Math.round(mbps)} Мбит/с`,
      );
    }
    if (server.id === bestId && index === 0) {
      marked = `${marked} · 🚀 Лучший`;
    } else if (gameHosts.has(`${server.host}:${server.port}`)) {
      marked = `${marked} · 🎮`;
    }
    // Метка узла второго типа обхода — словами «Белый список», в конце
    // строки: Happ определяет страну по первому флагу, а читается метка
    // только справа при прокрутке.
    if (isWhite) marked = `${marked} · Белый список`;
    // «Быстрый» — только реально проверенные узлы из закреплённой верхушки:
    // метка обещает работающий сервер, а не «первую строку списка». Раньше
    // она вешалась на любой из первых трёх, в том числе на непроверенный
    // запасной, и человек шёл именно в него.
    const fresh =
      (server.verified_latency_ms ?? 0) > 0 &&
      isWorkingServer(server, 72 * 60 * 60 * 1000);
    // Одна метка на строку: «🎮 · ⚡ быстрый» в карточке читается как мусор,
    // а игровой узел и так в верхушке — второе слово ему ничего не добавляет.
    // Замера нет — остаётся словесная метка, но врать цифрой нельзя.
    if (
      index < pinnedTotal &&
      server.tier !== "premium" &&
      fresh &&
      mbps < 5 &&
      !gameHosts.has(`${server.host}:${server.port}`)
    ) {
      marked = `${marked} · ⚡ быстрый`;
    }
    const titled = marked;
    const seen = (seenLabels.get(titled) ?? 0) + 1;
    seenLabels.set(titled, seen);
    const label = seen > 1 ? `${titled} #${seen}` : titled;
    uris.push(withLabel(cleanLink(server.link), label));
  });

  // Прямой резерв: вручную проверенные узлы из KV. Они не зависят ни от D1,
  // ни от пула, поэтому остаются в подписке даже при исчерпанной суточной
  // квоте базы — именно тогда люди и остаются без рабочих серверов.
  await appendDirectLinks(env, uris);

  // Импортированные внешние подписки — после прямого резерва и до якорей:
  // якоря обязаны остаться первыми, а узлы источников не должны вытеснять
  // проверенный резерв. Дубли по host:port отбрасываются внутри функции.
  try {
    await appendMergedLinks(env, uris);
  } catch {
    // без импорта подписка всё равно собирается
  }

  // Якоря — после резерва: в любой подписке они обязаны быть первыми.
  applyPinnedLinks(uris);

  // Пустой список не отправляем, пока есть резерв: заглушка выбивает из
  // клиента рабочие узлы, и человек остаётся без VPN при живых серверах
  // в базе (просто непроверенных в эту минуту).
  // «Автоматический выбор» — основная подписка.
  //
  // Одна ссылка = один профиль в клиенте. Внутри JSON с балансировщиком
  // leastPing: Happ сам проверяет узлы и уводит трафик на живой, поэтому
  // человеку не нужно выбирать страну руками. Старый список остаётся
  // доступен по /sub/<токен>/list — если клиент не понимает JSON.
  if (mode === "sb" && uris.length > 0) {
    return autoResponse(
      env,
      buildSingBoxConfig(uris, uris.length),
      user ? await buildUserinfo(env, user) : null,
      user,
    );
  }

  if (mode === "auto" && uris.length > 0) {
    return autoResponse(
      env,
      buildAutoConfig(uris, uris.length),
      user ? await buildUserinfo(env, user) : null,
      user,
    );
  }

  let body: string;
  if (uris.length > 0) {
    body = buildSubscription(uris);
  } else {
    const rescued = await fallbackBody(env, mode);
    body =
      rescued ??
      stubBody(
        mode === "default" && strict
          ? "Нет проверенных серверов — подписка обновится после проверки"
          : "Серверы временно недоступны — напишите боту",
      );
  }

  // Заголовок с тарифом и журнал загрузок — украшение, а не содержание:
  // при исчерпанной квоте D1 подписка всё равно должна собраться.
  let userinfo: string | null = null;
  try {
    userinfo = await buildUserinfo(env, user);
  } catch {
    userinfo = null;
  }
  try {
    await touchFetchLog(env, user, request);
  } catch {
    // журнал недоступен
  }

  // Снимок состава: если следующее обновление окажется хуже, админ сможет
  // вернуть человеку ровно этот набор. Пишем только когда состав изменился,
  // и только для основной подписки — режимы собираются на лету.
  if (mode === "default" && uris.length > 0) {
    try {
      await recordVersion(
        env,
        user,
        deliverable.map((server) => server.id),
      );
    } catch {
      // история версий недоступна — выдача от этого не страдает
    }
  }

  if (uris.length > 0) {
    // В строгом режиме кэш короткий: узел мог умереть минуту назад, и
    // десятиминутный кэш показывает человеку уже нерабочий список.
    const configured = Number(env.SUB_CACHE_TTL ?? "600") || 600;
    await env.CACHE.put(cacheKey, JSON.stringify({ body }), {
      expirationTtl: strict ? Math.min(configured, 900) : configured,
    });
    // Общий срез на случай, когда D1 упрётся в квоту: новому человеку
    // нечего взять из персонального кэша, а этот снимок уже есть.
    // Неделя хранения: сутки не перекрывали даже один сбой сборки, и
    // подписка «умирала» ровно на следующий день после сбоя.
    await env.CACHE.put(`snapshot:${mode}`, body, { expirationTtl: SNAPSHOT_TTL });
  }

  return plain(env, body, userinfo, user);
}

function plain(
  env: Env,
  body: string,
  userinfo: string | null,
  user: UserRow | null,
  title: string = BRAND_PREMIUM,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    // Карточка подписки в клиенте: имя тарифа, кнопка «сайт», поддержка.
    ...premiumHeaders({
      baseUrl: env.PUBLIC_BASE_URL ?? "",
      botUsername: env.BOT_USERNAME ?? "",
      refreshHours: PROFILE_REFRESH_HOURS,
      title,
    }),
    routing: routingLink(),
    "cache-control": "no-store",
    "x-sub-build": "v59-best-server",
  };
  // Заголовок нужен всегда: по нему клиент понимает срок и трафик.
  headers["subscription-userinfo"] =
    userinfo ?? "upload=0; download=0; total=0; expire=0";
  return new Response(body, { status: 200, headers });
}

/**
 * Ответ «Автоматический выбор»: JSON-конфиг вместо списка ссылок.
 *
 * Имя профиля — как в платных клиентах, поэтому человек видит один пункт
 * «Автоматический выбор», а не 40 стран. Счётчик тарифа и кнопки сервиса
 * остаются те же, что у обычной подписки.
 */
function autoResponse(
  env: Env,
  body: string,
  userinfo: string | null,
  user: UserRow | null,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    ...premiumHeaders({
      baseUrl: env.PUBLIC_BASE_URL ?? "",
      botUsername: env.BOT_USERNAME ?? "",
      refreshHours: PROFILE_REFRESH_HOURS,
      title: "Автоматический выбор",
    }),
    routing: routingLink(),
    "cache-control": "no-store",
    "x-sub-build": "v60-auto-json",
    "subscription-userinfo":
      userinfo ?? "upload=0; download=0; total=0; expire=0",
  };
  return new Response(body, { status: 200, headers });
}

/**
 * Лимит и срок конкретного человека — их и показывает Happ.
 *
 * Пустые поля не отдаём нулями: карточка «0 Б / 0 Б» и «срок не указан»
 * выглядит как сломанная бесплатная сборка. Если в базе лимит и срок не
 * заданы, подставляется тариф по умолчанию (PREMIUM_TRAFFIC_GB /
 * PREMIUM_PLAN_DAYS), а реальные значения из базы всегда важнее.
 */
async function buildUserinfo(env: Env, user: UserRow): Promise<string> {
  return subscriptionUserinfo(user, planDefaults(env));
}

/** Не чаще одного раза в час: экономит записи D1. */
async function touchFetchLog(env: Env, user: UserRow, request: Request): Promise<void> {
  const last = user.last_fetch_at
    ? Date.parse(user.last_fetch_at.replace(" ", "T") + "Z")
    : 0;
  if (Date.now() - last < 3600_000) return;

  const ipHash = await hashValue(clientIp(request), envStr(env.SALT));
  const uaHash = await hashValue(request.headers.get("User-Agent") ?? "-", envStr(env.SALT));
  const tsHour = new Date().toISOString().slice(0, 13);

  await run(
    env,
    "INSERT INTO fetch_log (user_id, ts_hour, ip_hash, ua_hash) VALUES (?, ?, ?, ?)",
    user.id,
    tsHour,
    ipHash,
    uaHash,
  );
  await run(env, "UPDATE users SET last_fetch_at = datetime('now') WHERE id = ?", user.id);

  const devices = await devices24h(env, user.id);
  if (devices > user.device_limit) {
    await logEvent(env, "device_limit", user.id, `устройств за 24 ч: ${devices}`);
  }
}

export interface UserDevice {
  id: number;
  label: string;
  last_seen: string;
  blocked: number;
}

/** «iPhone · Happ», «Windows · Happ» — без сырого User-Agent. */
export function deviceLabel(ua: string): string {
  const app = /happ/i.test(ua)
    ? "Happ"
    : /streisand/i.test(ua)
      ? "Streisand"
      : /v2rayng/i.test(ua)
        ? "v2rayNG"
        : /hiddify/i.test(ua)
          ? "Hiddify"
          : /shadowrocket/i.test(ua)
            ? "Shadowrocket"
            : /foxray/i.test(ua)
              ? "FoXray"
              : /clash|mihomo/i.test(ua)
                ? "Clash"
                : "Клиент";

  const os = /ipad/i.test(ua)
    ? "iPad"
    : /iphone|ios/i.test(ua)
      ? "iPhone"
      : /android/i.test(ua)
        ? "Android"
        : /windows/i.test(ua)
          ? "Windows"
          : /macintosh|mac os/i.test(ua)
            ? "macOS"
            : /linux/i.test(ua)
              ? "Linux"
              : "Устройство";

  return `${os} · ${app}`;
}

/**
 * Регистрирует устройство при каждом запросе подписки и сообщает,
 * заблокировано ли оно. Ключ — хеш User-Agent с солью.
 */
export async function touchDevice(
  env: Env,
  userId: number,
  ua: string,
): Promise<{ blocked: boolean } | null> {
  if (!ua || ua === "-") return null;
  const key = await hashValue(ua, envStr(env.SALT));

  await run(
    env,
    `INSERT INTO user_devices (user_id, device_key, label) VALUES (?, ?, ?)
     ON CONFLICT (user_id, device_key)
     DO UPDATE SET last_seen = datetime('now'), label = excluded.label`,
    userId,
    key,
    deviceLabel(ua),
  );

  const row = await one<{ blocked: number }>(
    env,
    "SELECT blocked FROM user_devices WHERE user_id = ? AND device_key = ?",
    userId,
    key,
  );
  return { blocked: row?.blocked === 1 };
}

export async function listDevices(env: Env, userId: number): Promise<UserDevice[]> {
  return await many<UserDevice>(
    env,
    `SELECT id, label, last_seen, blocked FROM user_devices
      WHERE user_id = ? ORDER BY blocked ASC, last_seen DESC LIMIT 10`,
    userId,
  );
}

export async function setDeviceBlocked(
  env: Env,
  userId: number,
  id: number,
  blocked: boolean,
): Promise<boolean> {
  const result = await run(
    env,
    "UPDATE user_devices SET blocked = ? WHERE id = ? AND user_id = ?",
    blocked ? 1 : 0,
    id,
    userId,
  );
  return Boolean(result.meta.changes);
}

export async function devices24h(env: Env, userId: number): Promise<number> {
  const row = await one<{ n: number }>(
    env,
    `SELECT COUNT(DISTINCT ip_hash || ':' || ua_hash) AS n
     FROM fetch_log
     WHERE user_id = ? AND ts_hour >= strftime('%Y-%m-%dT%H', datetime('now', '-24 hours'))`,
    userId,
  );
  return row?.n ?? 0;
}

export async function rotateToken(env: Env, user: UserRow): Promise<string> {
  const token = randomToken(32);
  await run(env, "UPDATE users SET sub_token = ? WHERE id = ?", token, user.id);
  await env.CACHE.delete(`sub:v1:${user.sub_token}`);
  await logEvent(env, "newkey", user.id, "ссылка перевыпущена");
  return token;
}

export async function invalidateSubscription(env: Env, token: string): Promise<void> {
  // Чистим все версии и все режимы: ключ теперь включает mode, и одна
  // оставшаяся копия покажет человеку старый список серверов.
  const versions = ["v1", "v2", "v3", "v50", "v67"];
  const keys = versions.flatMap((version) => [
    // Старый формат без режима — тоже мог остаться в KV.
    `sub:${version}:${token}`,
    ...["default", "reality", "working", "best", "stable", "low-latency", "untested", "byedpi"].map(
      (mode) => `sub:${version}:${mode}:${token}`,
    ),
  ]);
  await Promise.all(keys.map((key) => env.CACHE.delete(key)));
}

export interface PickItem {
  id: number;
  country: string;
  label: string;
  latency: number | null;
}

/**
 * Список серверов, доступных конкретному человеку — тем же отбором, что
 * и подписка. Нужен боту, чтобы показать «Выбрать сервер» без расхождений
 * с тем, что реально приедет в Happ.
 */
export async function listAvailableServers(
  env: Env,
  user: UserRow,
  isAdmin: boolean,
  limit = 10,
): Promise<PickItem[]> {
  const rows = await many<DeliverableServer>(
    env,
    isStrictDefault(env) ? SERVER_SQL_LIGHT : SERVER_SQL,
    user.id,
    isAdmin ? 1 : 0,
  );
  const userTier = isAdmin ? "personal" : (user.tier ?? "free");

  return rows
    .filter((row) => isDeliverable(row, isAdmin))
    .filter((row) => row.enabled !== 0)
    .filter((row) => {
      const tier = row.tier ?? "free";
      if (tier === "personal") return isAdmin;
      if (userTier === "premium") return true;
      return tier === "free";
    })
    .filter(isModern)
    // Бот показывает ровно то, что приедет в подписке: иначе человек
    // выбирает сервер, которого в Happ не будет.
    .filter((row) => (isStrictDefault(env) ? isWorkingServer(row) : true))
    .sort(compareServers)
    .slice(0, limit)
    .map((row) => {
      const country = row.country_name ?? "";
      const ping = row.latency_ms ? `${row.latency_ms} мс` : "—";
      return {
        id: row.id,
        country: row.country_code ?? "",
        label: country ? `${country} · ${ping}` : `Сервер #${row.id} · ${ping}`,
        latency: row.latency_ms ?? null,
      };
    });
}
