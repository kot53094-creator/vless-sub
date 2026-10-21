/**
 * Инвайты: одноразовые ссылки на подписку.
 *
 * Владелец создаёт ссылку с условиями (дни, ГБ, устройства) и отправляет
 * другу. Тот открывает бота — и сразу получает активную подписку, без
 * ручного одобрения. Ссылка сгорает после первого использования.
 */

import { logEvent, many, one, run } from "./db";
import { envStr } from "./security";
import type { Env } from "./types";

export interface Invite {
  code: string;
  days: number;
  gb: number;
  devices: number;
  note: string;
  created_at: string;
  used_by: number | null;
  used_at: string | null;
}

/** Без похожих символов: код диктуют голосом и переписывают руками. */
function inviteCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

export async function createInvite(
  env: Env,
  input: { days: number; gb: number; devices: number; note?: string },
): Promise<Invite> {
  const code = inviteCode();
  const days = Math.max(1, Math.min(3650, Math.round(input.days)));
  const gb = Math.max(0, Math.round(input.gb));
  const devices = Math.max(1, Math.min(50, Math.round(input.devices)));

  await run(
    env,
    "INSERT INTO invites (code, days, gb, devices, note) VALUES (?, ?, ?, ?, ?)",
    code,
    days,
    gb,
    devices,
    (input.note ?? "").slice(0, 120),
  );
  await logEvent(env, "invite_new", null, `${code}: ${days} дн, ${gb} ГБ, ${devices} устр.`);

  return { code, days, gb, devices, note: input.note ?? "", created_at: "", used_by: null, used_at: null };
}

export function inviteLink(env: Env, code: string): string {
  const bot = envStr(env.BOT_USERNAME).replace(/^@/, "") || "your_bot";
  return `https://t.me/${bot}?start=inv_${code}`;
}

export async function listInvites(env: Env): Promise<Invite[]> {
  return await many<Invite>(
    env,
    "SELECT * FROM invites ORDER BY created_at DESC LIMIT 100",
  );
}

/**
 * Погасить инвайт. Возвращает условия или null, если код неизвестен
 * или уже использован. Защита от гонки — условный UPDATE.
 */
export async function redeemInvite(
  env: Env,
  rawCode: string,
  userId: number,
): Promise<{ days: number; gb: number; devices: number } | null> {
  const code = rawCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code) return null;

  const invite = await one<Invite>(env, "SELECT * FROM invites WHERE code = ?", code);
  if (!invite || invite.used_by !== null) return null;

  const claim = await run(
    env,
    "UPDATE invites SET used_by = ?, used_at = datetime('now') WHERE code = ? AND used_by IS NULL",
    userId,
    code,
  );
  if (!claim.meta.changes) return null;

  await logEvent(env, "invite_used", userId, code);
  return { days: invite.days, gb: invite.gb, devices: invite.devices };
}

export async function revokeInvite(env: Env, code: string): Promise<boolean> {
  const result = await run(env, "DELETE FROM invites WHERE code = ? AND used_by IS NULL", code);
  return Boolean(result.meta.changes);
}
