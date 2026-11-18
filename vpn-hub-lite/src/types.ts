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

  // ── свой узел ───────────────────────────────────────────────────────────
  /** IP или домен своего сервера. Пусто — узел не используется. */
  NODE_HOST?: string;
  NODE_PORT?: string;
  /** Публичный ключ REALITY (xray x25519 → Public key). */
  NODE_PUBKEY?: string;
  NODE_SID?: string;
  NODE_SNI?: string;
  /** Подпись узла в списке серверов, например «🇷🇺 Россия · свой». */
  NODE_NAME?: string;

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

  // ── платный контур ──────────────────────────────────────────────────────
  /**
   * Какие способы оплаты включены: "stars,cryptopay,yookassa".
   * Пусто — включаются сами те, для которых заданы секреты (Stars — всегда).
   * Провайдер без секретов не показывается пользователю и не принимает
   * вебхуки: «кнопка есть, а оплата не проходит» — худший вариант витрины.
   */
  PAY_PROVIDERS?: string;
  /** Токен Crypto Bot (@CryptoBot → Crypto Pay). Оплата в USDT/TON. */
  CRYPTOPAY_TOKEN?: string;
  /** ЮKassa: shopId и секретный ключ. Оплата картой РФ на сайте. */
  YOOKASSA_SHOP_ID?: string;
  YOOKASSA_SECRET?: string;
  /** Почта для чека 54-ФЗ; без неё чек не отправляется. */
  YOOKASSA_RECEIPT_EMAIL?: string;
  /** Сколько рублей стоит одна звезда Telegram (для пересчёта цены). */
  STAR_RUB?: string;
  /** Сколько дней живёт неоплаченный заказ (по умолчанию 24 ч). */
  ORDER_TTL_HOURS?: string;
  /** "0" — не выдавать 7-дневный пробный доступ новым пользователям. */
  TRIAL_ENABLED?: string;
  /** Длина пробного периода в днях (по умолчанию 3). */
  TRIAL_DAYS?: string;
  /** Лимит устройств на пробном периоде. */
  TRIAL_DEVICES?: string;
  /** Лимит устройств по умолчанию, если в тарифе не задан (2). */
  DEVICE_LIMIT?: string;
  /** "0" — выключить массовую проверку узлов и утреннюю пересборку пула. */
  CHECKS_ENABLED?: string;
  /** Сколько часов проверка узла считается свежей (по умолчанию 72). */
  VERIFIED_MAX_AGE_H?: string;
  /** Токен агента узлов для POST /api/traffic. */
  TRAFFIC_TOKEN?: string;
  /** Перевод без эквайринга: телефон СБП, номер карты, имя получателя. */
  PAY_PHONE?: string;
  PAY_CARD?: string;
  PAY_RECEIVER?: string;
  /** Куда приходят деньги: реквизиты для страницы оферты. */
  LEGAL_ENTITY?: string;
  LEGAL_INN?: string;
  LEGAL_EMAIL?: string;
  LEGAL_TG?: string;

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
  /** Безопасный период после исчезновения узла из источника, часы (24). */
  MERGE_GRACE_HOURS?: string;
  /** Сколько узлов класть в группу AUTO (12). */
  GROUP_AUTO_TOP?: string;
  /** Тихие часы по местному времени, «23-8»; off — выключить. */
  QUIET_HOURS?: string;
  /** Смещение местного времени от UTC в часах (8). */
  QUIET_UTC_OFFSET?: string;
  /** Потолок узлов на группу (40). */
  GROUP_LIMIT?: string;

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
  /** Израсходовано с последнего сброса, МБ. Заполняет агент узлов. */
  traffic_used_mb?: number;
  /** Докупленные гигабайты сверх тарифной квоты (0025). */
  traffic_extra_gb?: number;
  traffic_reset_at?: string | null;
  traffic_reported_at?: string | null;
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
  /**
   * Открывает ли Gemini. Нужен отдельно от blocked_ok: узел с российским
   * выходом тянет YouTube и ChatGPT, но Gemini в РФ недоступен, и в общем
   * автоотборе такой узел ломает именно нейросети.
   */
  ai_ok?: number | null;
}

