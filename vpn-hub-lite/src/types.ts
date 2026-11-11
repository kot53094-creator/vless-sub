/** Общие типы и окружение Worker. */

export interface Env {
  DB: D1Database;
  /** Turso (libSQL): если заданы оба — чтения идут туда. */
  TURSO_URL?: string;
  TURSO_TOKEN?: string;
  CACHE: KVNamespace;

  // секреты (wrangler secret put ...)
  BOT_TOKEN: string;
  ADMIN_TOKEN: string;
  SALT: string;
  WEBHOOK_SECRET: string;
  ADMIN_TG_ID?: string;

  // публичные переменные (wrangler.toml [vars])
  PUBLIC_BASE_URL: string;
  MAX_USERS?: string;
  SERVERS_PER_USER?: string;
  FETCH_UA?: string;
  SUB_CACHE_TTL?: string;
  /** "1" — отдавать текст ошибки сборки подписки вместо снимка. Для отладки. */
  SUB_DEBUG?: string;
  /** "1" (по умолчанию) — в подписке только проверенные VLESS + REALITY. */
  STRICT_WORKING?: string;
  /** webhook — Telegram сам присылает обновления; polling — забираем по cron. */
  BOT_TRANSPORT?: string;
  /** Канал для проверки подписки (@name или -100...). Пусто — награда выключена. */
  CHANNEL_ID?: string;
  /** Username бота без @ — для реферальных ссылок. */
  BOT_USERNAME?: string;
  /** Общий секрет агента проверок: заголовок x-check-token. */
  CHECK_TOKEN?: string;

  // «Платный» вид карточки подписки в клиенте.
  /** "0" — не подставлять тариф по умолчанию, показывать только данные из базы. */
  PREMIUM_LOOK?: string;
  /** Объём тарифа по умолчанию, ГБ. */
  PREMIUM_TRAFFIC_GB?: string;
  /** Срок тарифа по умолчанию, дней вперёд. */
  PREMIUM_PLAN_DAYS?: string;
  /** Порог сторожа пула: меньше этого числа проверенных узлов — тревога админу. */
  POOL_MIN?: string;

  /** Необязательный токен GitHub: поднимает лимит поиска источников. */
  GITHUB_TOKEN?: string;

  /** "0" — у каждого свой набор узлов; по умолчанию у всех одинаковый. */
  SHARED_LIST?: string;

  /**
   * Биндинг Workers AI (бесплатные 10 000 нейронов в сутки).
   * Нет биндинга — ИИ-админ отвечает «модель недоступна», остальное работает.
   */
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };

  // Внешние разрешённые подписки: только Cloudflare Secrets, не vars.
  MERGE_SOURCE_A?: string;
  MERGE_SOURCE_B?: string;
  MERGE_SOURCE_C?: string;
  /** HWID устройства для панелей Remnawave: без него отдают заглушку. */
  MERGE_HWID?: string;
  /** "0" — не подмешивать импортированные узлы в подписку. */
  MERGE_ENABLED?: string;

  // Remnawave (необязательно). Пусто — группы работают только в нашей D1.
  REMNAWAVE_URL?: string;
  REMNAWAVE_TOKEN?: string;
  RW_PATH_USER_BY_TG?: string;
  RW_PATH_USER_UPDATE?: string;
}

export type UserStatus = "pending" | "active" | "banned" | "expired";
export type SourceKind =
  | "own_vps"
  | "trial"
  | "public"
  | "bridge_ru"
  | "cdn_xhttp"
  | "paid_private";
export type Visibility = "private" | "shareable";
export type Health = "alive" | "dead" | "unknown";

export interface UserRow {
  id: number;
  tg_id: string;
  tg_username: string;
  status: UserStatus;
  created_at: string;
  expires_at: string | null;
  device_limit: number;
  sub_token: string;
  last_fetch_at: string | null;
  traffic_gb?: number;
  tier?: string;
  preferred_server?: number | null;
  preferred_country?: string | null;
  note: string;
}

export interface SourceRow {
  id: number;
  name: string;
  kind: SourceKind;
  url_or_link: string;
  created_at: string;
  expires_at: string | null;
  traffic_total: number | null;
  traffic_used: number | null;
  status: Health;
  latency_ms: number | null;
  last_check_at: string | null;
  last_sync_at: string | null;
  visibility: Visibility;
  last_error: string;
  max_devices: number;
  /** 1 — источник найден автоматически и ещё не доказал качество. */
  quarantine?: number | null;
}

export interface ServerRow {
  id: number;
  source_id: number;
  remark: string;
  link: string;
  host: string;
  port: number;
  status: Health;
  latency_ms: number | null;
  last_check_at: string | null;
  max_users: number;
  seen_at: string | null;
}

export interface DeliverableServer extends ServerRow {
  visibility: Visibility;
  /** До какого момента источник считается общим (shareable). */
  share_until?: string | null;
  source_kind: SourceKind;
  pool_name: string | null;
  country_name?: string | null;
  city?: string | null;
  country_code?: string | null;
  tier?: string | null;
  enabled?: number | null;
  priority?: number | null;
  stability?: number | null;
  /** Когда последний раз туннель реально проверяли и с каким результатом. */
  verified_at?: string | null;
  verified_latency_ms?: number | null;
  /** Выходной IP: доказывает, что узел хоть раз реально пробил туннель. */
  exit_ip?: string | null;
  /** Открывает ли Telegram/Discord: 0 — проверен и не открывает. */
  blocked_ok?: number | null;
  /** Скорость скачивания через туннель, Мбит/с (замер агента). */
  speed_mbps?: number | null;
}
