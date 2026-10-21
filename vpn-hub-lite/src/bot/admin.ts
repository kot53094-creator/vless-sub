/** Админские команды. Любой другой ID игнорируется без ответа. */

import { assignForUser, rebalance, serverLoads } from "../balance";
import { topUpAllActive } from "../delivery";
import { daysFromNowIso, logEvent, many, one, run } from "../db";
import { parseSubscription, parseUri } from "../parser";
import { buildReport } from "../reports";
import { invalidateSubscription } from "../sub";
import type { Env, UserRow } from "../types";
import { escapeHtml, sendMessage } from "./telegram";

const KINDS = ["own_vps", "trial", "public", "bridge_ru", "cdn_xhttp", "paid_private"];

function userLine(user: UserRow & { devices?: number }): string {
  const name = user.tg_username ? `@${user.tg_username}` : `id ${user.tg_id}`;
  const until = user.expires_at ? user.expires_at.slice(0, 10) : "—";
  return `${name} · ${user.status} · до ${until} · устр. ${user.devices ?? 0}/${user.device_limit}`;
}

export async function cmdUsers(env: Env): Promise<void> {
  const users = await many<UserRow & { devices: number }>(
    env,
    `SELECT u.*, (
       SELECT COUNT(DISTINCT f.ip_hash || ':' || f.ua_hash) FROM fetch_log f
       WHERE f.user_id = u.id AND f.ts_hour >= strftime('%Y-%m-%dT%H', datetime('now','-24 hours'))
     ) AS devices
     FROM users u ORDER BY u.created_at DESC LIMIT 30`,
  );
  if (!users.length) {
    await sendMessage(env, String(env.ADMIN_TG_ID), "Пользователей пока нет.");
    return;
  }
  const lines = ["<b>Пользователи</b>"];
  for (const user of users) lines.push(`• ${userLine(user)}\n  <code>${user.tg_id}</code>`);
  lines.push("", "Подробности: /user &lt;tg_id&gt;");
  await sendMessage(env, String(env.ADMIN_TG_ID), lines.join("\n"));
}

export async function cmdUser(env: Env, tgId: string): Promise<string> {
  const user = await one<UserRow>(env, "SELECT * FROM users WHERE tg_id = ?", tgId);
  if (!user) return "Не нашёл такого пользователя.";

  const assignments = await many<{ remark: string; host: string; status: string }>(
    env,
    `SELECT s.remark, s.host, s.status FROM assignments a
     JOIN servers s ON s.id = a.server_id WHERE a.user_id = ?`,
    user.id,
  );
  const pools = await many<{ name: string }>(
    env,
    `SELECT p.name FROM user_pools up JOIN pools p ON p.id = up.pool_id WHERE up.user_id = ?`,
    user.id,
  );

  return [
    `<b>Пользователь</b> ${escapeHtml(user.tg_username ? "@" + user.tg_username : user.tg_id)}`,
    `id: <code>${user.id}</code>, tg: <code>${user.tg_id}</code>`,
    `Статус: ${user.status}, срок: ${user.expires_at?.slice(0, 10) ?? "—"}`,
    `Лимит устройств: ${user.device_limit}`,
    `Пулы: ${pools.map((p) => escapeHtml(p.name)).join(", ") || "—"}`,
    `Серверы (${assignments.length}):`,
    ...assignments.map(
      (a) => `  • ${escapeHtml(a.remark || a.host)} — ${a.status}`,
    ),
  ].join("\n");
}

export async function cmdApprove(env: Env, tgId: string, days: number): Promise<string> {
  const user = await one<UserRow>(env, "SELECT * FROM users WHERE tg_id = ?", tgId);
  if (!user) return "Не нашёл такого пользователя.";
  const { approveUser } = await import("./user");
  await approveUser(env, user.id, days);
  return `Одобрен ${tgId} на ${days} дн.`;
}

export async function cmdSetStatus(
  env: Env,
  tgId: string,
  field: "status" | "extend" | "limit",
  value: string,
): Promise<string> {
  const user = await one<UserRow>(env, "SELECT * FROM users WHERE tg_id = ?", tgId);
  if (!user) return "Не нашёл такого пользователя.";

  if (field === "status") {
    await run(env, "UPDATE users SET status = ? WHERE id = ?", value, user.id);
    await invalidateSubscription(env, user.sub_token);
    await logEvent(env, "status", user.id, value);
    return `Статус ${tgId}: ${value}`;
  }
  if (field === "extend") {
    const days = Number(value);
    if (!Number.isFinite(days)) return "Нужно число дней.";
    const base = user.expires_at ? new Date(user.expires_at.replace(" ", "T") + "Z") : new Date();
    const from = Math.max(base.getTime(), Date.now());
    const next = new Date(from + days * 86400_000).toISOString().slice(0, 19).replace("T", " ");
    await run(env, "UPDATE users SET status='active', expires_at=? WHERE id=?", next, user.id);
    await invalidateSubscription(env, user.sub_token);
    await logEvent(env, "extend", user.id, `+${days} дн.`);
    return `Продлён ${tgId} до ${next.slice(0, 10)}.`;
  }
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit < 1) return "Лимит должен быть числом ≥ 1.";
  await run(env, "UPDATE users SET device_limit = ? WHERE id = ?", limit, user.id);
  return `Лимит устройств ${tgId}: ${limit}.`;
}

export async function cmdPools(env: Env): Promise<string> {
  const pools = await many<{ id: number; name: string; users: number; servers: number }>(
    env,
    `SELECT p.id, p.name,
       (SELECT COUNT(*) FROM user_pools up WHERE up.pool_id = p.id) AS users,
       (SELECT COUNT(*) FROM pool_servers ps WHERE ps.pool_id = p.id) AS servers
     FROM pools p ORDER BY p.id`,
  );
  return [
    "<b>Пулы</b>",
    ...pools.map(
      (p) => `• ${p.id}. ${escapeHtml(p.name)} — людей ${p.users}, серверов ${p.servers}`,
    ),
    "",
    "Выдать: /grant &lt;tg_id&gt; &lt;пул&gt;, отозвать: /revoke &lt;tg_id&gt; &lt;пул&gt;",
  ].join("\n");
}

export async function cmdGrant(
  env: Env,
  tgId: string,
  poolRef: string,
  revoke = false,
): Promise<string> {
  const user = await one<UserRow>(env, "SELECT * FROM users WHERE tg_id = ?", tgId);
  if (!user) return "Не нашёл такого пользователя.";

  const pool = await one<{ id: number; name: string }>(
    env,
    "SELECT id, name FROM pools WHERE id = ? OR lower(name) = lower(?)",
    Number(poolRef) || -1,
    poolRef,
  );
  if (!pool) return "Не нашёл такой пул.";

  if (revoke) {
    await run(env, "DELETE FROM user_pools WHERE user_id = ? AND pool_id = ?", user.id, pool.id);
    await run(
      env,
      `DELETE FROM assignments WHERE user_id = ? AND server_id IN
         (SELECT server_id FROM pool_servers WHERE pool_id = ?)`,
      user.id,
      pool.id,
    );
    await invalidateSubscription(env, user.sub_token);
    return `Пул «${pool.name}» отозван у ${tgId}.`;
  }

  await run(env, "INSERT OR IGNORE INTO user_pools (user_id, pool_id) VALUES (?, ?)", user.id, pool.id);
  const assigned = await assignForUser(env, user.id, Number(env.SERVERS_PER_USER ?? "3"));
  await invalidateSubscription(env, user.sub_token);
  return `Пул «${pool.name}» выдан ${tgId}. Серверов у него: ${assigned.length}.`;
}

export async function cmdServers(env: Env): Promise<string> {
  const servers = await serverLoads(env, 25);
  if (!servers.length) return "Серверов нет. Добавьте источники: /addkey";
  const lines = ["<b>Серверы</b> (загрузка)"];
  for (const server of servers) {
    const pct = server.max_users ? Math.round((server.load / server.max_users) * 100) : 0;
    const mark = server.status === "alive" ? "🟢" : server.status === "dead" ? "🔴" : "⚪";
    lines.push(
      `${mark} ${escapeHtml(server.host)}:${server.port} · ${pct}% (${server.load}/${server.max_users}) · ${server.latency_ms ?? "—"} мс`,
    );
  }
  return lines.join("\n");
}

export async function cmdRebalance(env: Env): Promise<string> {
  const moves = await rebalance(env);
  return moves ? `Перераспределено назначений: ${moves}.` : "Всё уже сбалансировано.";
}

export async function cmdAddSource(
  env: Env,
  name: string,
  kind: string,
  url: string,
): Promise<string> {
  if (!KINDS.includes(kind)) return `Тип должен быть одним из: ${KINDS.join(", ")}`;
  if (!url) return "Нужна ссылка.";

  const visibility = kind === "paid_private" ? "private" : "shareable";
  const result = await run(
    env,
    `INSERT INTO sources (name, kind, url_or_link, status, visibility)
     VALUES (?, ?, ?, 'unknown', ?)`,
    name.slice(0, 80),
    kind,
    url,
    visibility,
  );
  await logEvent(env, "source_add", null, `${kind}: ${name}`);
  return `Источник #${result.meta.last_row_id} добавлен (${kind}, ${visibility}).\nПервый sync подхватит его в ближайшие 6 часов.`;
}

export async function cmdDelSource(env: Env, id: number): Promise<string> {
  const source = await one<{ id: number; name: string }>(
    env,
    "SELECT id, name FROM sources WHERE id = ?",
    id,
  );
  if (!source) return "Нет такого источника.";
  await run(env, "DELETE FROM sources WHERE id = ?", id);
  await logEvent(env, "source_delete", null, `#${id} ${source.name}`);
  return `Источник #${id} «${source.name}» удалён вместе с серверами.`;
}

export async function cmdPrivate(env: Env, id: number): Promise<string> {
  const source = await one<{ id: number; name: string }>(
    env,
    "SELECT id, name FROM sources WHERE id = ?",
    id,
  );
  if (!source) return "Нет такого источника.";
  await run(env, "UPDATE sources SET visibility='private' WHERE id = ?", id);
  await run(
    env,
    `DELETE FROM assignments WHERE server_id IN (SELECT id FROM servers WHERE source_id = ?)`,
    id,
  );
  await logEvent(env, "source_private", null, `#${id} ${source.name}`);
  return `Источник #${id} теперь приватный: его серверы никому не выдаются.`;
}

export async function cmdReport(env: Env): Promise<string> {
  return await buildReport(env);
}

/**
 * /addkey: принимает vless://…, несколько строк или ссылку-подписку.
 * Возвращает текст ответа.
 */
export async function addKeys(env: Env, raw: string): Promise<string> {
  const text = raw.trim();
  if (!text) return "Пустое сообщение.";

  if (/^https?:\/\//i.test(text) && !text.includes("\n")) {
    return await cmdAddSource(env, `Подписка ${new Date().toISOString().slice(0, 10)}`, "public", text);
  }

  const keys = parseSubscription(text, 120);
  if (!keys.length) return "Не нашёл ни одного ключа. Пришлите vless://, vmess://, trojan://, ss:// или hysteria2://.";

  const result = await run(
    env,
    `INSERT INTO sources (name, kind, url_or_link, status, visibility)
     VALUES (?, 'own_vps', ?, 'alive', 'shareable')`,
    `Ключи ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    text.slice(0, 200_000),
  );
  const sourceId = Number(result.meta.last_row_id ?? 0);

  for (const key of keys) {
    await run(
      env,
      `INSERT INTO servers (source_id, remark, link, host, port, status, seen_at, max_users)
       VALUES (?, ?, ?, ?, ?, 'alive', datetime('now'), 10)
       ON CONFLICT (source_id, host, port) DO UPDATE SET link=excluded.link`,
      sourceId,
      key.remark.slice(0, 120),
      key.uri,
      key.host,
      key.port,
    );
  }

  await run(
    env,
    `INSERT OR IGNORE INTO pool_servers (pool_id, server_id)
     SELECT (SELECT id FROM pools ORDER BY id LIMIT 1), id FROM servers WHERE source_id = ?`,
    sourceId,
  );

  // Новым серверам нужны люди: выдаём их тем, кому ещё ничего не досталось.
  await run(
    env,
    `INSERT OR IGNORE INTO user_pools (user_id, pool_id)
     SELECT u.id, p.id FROM users u, pools p
     WHERE u.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM user_pools up WHERE up.user_id = u.id)`,
  );
  // Доводим выдачу до нормы у всех: иначе новые ключи не попадают в подписку.
  const delivered = await topUpAllActive(env);
  await logEvent(env, "addkey", null, `источник #${sourceId}, ключей ${keys.length}`);
  return `Добавлено ключей: ${keys.length} (источник #${sourceId}), роздано серверам: ${delivered}.`;
}

export async function peekKey(env: Env, id: number): Promise<string> {
  const source = await one<{ url_or_link: string }>(
    env,
    "SELECT url_or_link FROM sources WHERE id = ?",
    id,
  );
  const key = source ? parseUri(source.url_or_link) : null;
  return key ? `${key.host}:${key.port}` : "—";
}
