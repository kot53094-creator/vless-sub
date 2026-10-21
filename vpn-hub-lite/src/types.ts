/** Общие типы и окружение Worker. */

export interface Env {
  DB: D1Database;
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
  source_kind: SourceKind;
  pool_name: string | null;
}
