/**
 * Клиент Remnawave — только для групп (squads) и зеркалирования срока/трафика.
 *
 * Панель пока не подключена (REMNAWAVE_URL пустой), поэтому весь модуль
 * работает как no-op: начисления идут в нашу D1, бот не падает.
 * Пути и имена полей у Remnawave меняются между версиями, поэтому их можно
 * переопределить переменными окружения RW_PATH_*.
 */

import { envStr } from "./security";
import type { Env, UserRow } from "./types";

export function remnawaveEnabled(env: Env): boolean {
  return Boolean(envStr(env.REMNAWAVE_URL) && envStr(env.REMNAWAVE_TOKEN));
}

interface RwUser {
  uuid?: string;
  id?: number;
  expireAt?: string;
  trafficLimitBytes?: number;
  activeInternalSquads?: Array<{ uuid?: string; name?: string }>;
}

async function rwFetch<T>(
  env: Env,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T | null> {
  const base = envStr(env.REMNAWAVE_URL).replace(/\/$/, "");
  const token = envStr(env.REMNAWAVE_TOKEN);
  if (!base || !token) return null;
  try {
    const response = await fetch(`${base}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function userPath(env: Env, tgId: string): string {
  const template = envStr(env.RW_PATH_USER_BY_TG) || "/api/users/by-telegram-id/{tg}";
  return template.replace("{tg}", encodeURIComponent(tgId));
}

export async function findRemnawaveUser(env: Env, tgId: string): Promise<RwUser | null> {
  if (!remnawaveEnabled(env)) return null;
  const data = await rwFetch<{ response?: RwUser } & RwUser>(env, userPath(env, tgId));
  return data?.response ?? data ?? null;
}

/**
 * Зеркалируем продление срока и трафика. Ошибки не отменяют начисление:
 * источник истины для наших подписок — D1, Remnawave вторичен.
 */
export async function pushToRemnawave(
  env: Env,
  user: UserRow,
  extraHours: number,
  extraGb: number,
): Promise<boolean> {
  if (!remnawaveEnabled(env)) return false;
  const remote = await findRemnawaveUser(env, user.tg_id);
  if (!remote || !remote.uuid) return false;

  const patch: Record<string, unknown> = { uuid: remote.uuid };
  if (extraHours > 0 && remote.expireAt) {
    const base = Date.parse(remote.expireAt);
    const from = Number.isFinite(base) ? Math.max(base, Date.now()) : Date.now();
    patch.expireAt = new Date(from + extraHours * 3600_000).toISOString();
  }
  if (extraGb > 0) {
    const current = Number(remote.trafficLimitBytes ?? 0);
    // 0 у Remnawave = без лимита, увеличивать нечего.
    if (current > 0) patch.trafficLimitBytes = current + extraGb * 1024 ** 3;
  }

  const path = envStr(env.RW_PATH_USER_UPDATE) || "/api/users";
  const result = await rwFetch(env, path, { method: "PATCH", body: patch });
  return result !== null;
}

/** Выдать пользователю группу (squad) в Remnawave. */
export async function pushSquad(env: Env, tgId: string, squadUuid: string): Promise<boolean> {
  if (!remnawaveEnabled(env)) return false;
  const remote = await findRemnawaveUser(env, tgId);
  if (!remote?.uuid) return false;
  const squads = new Set<string>(
    (remote.activeInternalSquads ?? []).map((item) => item.uuid ?? "").filter(Boolean),
  );
  squads.add(squadUuid);
  const path = envStr(env.RW_PATH_USER_UPDATE) || "/api/users";
  const result = await rwFetch(env, path, {
    method: "PATCH",
    body: { uuid: remote.uuid, activeInternalSquads: [...squads] },
  });
  return result !== null;
}
