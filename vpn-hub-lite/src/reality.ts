/**
 * Проверка VLESS + REALITY по фактическим полям URI.
 * Никаких догадок по названию: смотрим схему, security и обязательные поля.
 */

export interface RealityParams {
  uuid: string;
  host: string;
  port: number;
  pbk: string;
  sni: string;
  sid: string;
  fp: string;
  type: string;
}

export interface RealityCheck {
  ok: boolean;
  errors: string[];
  params: RealityParams | null;
}

function pick(q: URLSearchParams, ...names: string[]): string {
  for (const n of names) {
    const v = q.get(n);
    if (v) return v;
  }
  return "";
}

export function checkReality(uri: string): RealityCheck {
  const errors: string[] = [];
  if (!/^vless:\/\//i.test(uri)) {
    return { ok: false, errors: ["не VLESS"], params: null };
  }

  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { ok: false, errors: ["не разбирается как URL"], params: null };
  }

  const uuid = decodeURIComponent(url.username || "");
  const host = url.hostname;
  const port = Number(url.port || 443);
  const q = url.searchParams;

  const security = (q.get("security") ?? "").toLowerCase();
  if (security !== "reality") errors.push("security не reality");

  const pbk = pick(q, "pbk", "publicKey");
  const sni = pick(q, "sni", "serverName");
  const sid = pick(q, "sid", "shortId");
  const fp = pick(q, "fp", "fingerprint");

  if (!uuid) errors.push("нет UUID");
  if (!host) errors.push("нет адреса");
  if (!Number.isFinite(port) || port <= 0) errors.push("нет порта");
  if (!pbk) errors.push("нет pbk");
  if (!sni) errors.push("нет sni");
  if (!sid) errors.push("нет sid");
  if (!fp) errors.push("нет fp");

  return {
    ok: errors.length === 0,
    errors,
    params: {
      uuid,
      host,
      port,
      pbk,
      sni,
      sid,
      fp,
      type: (q.get("type") ?? "tcp").toLowerCase(),
    },
  };
}

/** Короткая причина для админки: почему конфигурация не попала в REALITY. */
export function rejectReason(uri: string): string | null {
  const check = checkReality(uri);
  return check.ok ? null : check.errors.join(", ");
}
