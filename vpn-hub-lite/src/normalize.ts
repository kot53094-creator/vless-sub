/**
 * Починка VLESS-ссылок перед выдачей.
 *
 * Что здесь можно и чего нельзя:
 *  • нельзя «переписать» сервер — UUID, порт и ключи REALITY заданы на нём;
 *  • можно исправить саму ссылку: склеенные параметры, двойное
 *    кодирование пути, IPv6 без квадратных скобок, дубли ключей,
 *    недопустимый fingerprint.
 *
 * Всё, что делается ниже, не меняет смысл подключения: либо чинит
 * синтаксис, либо выбрасывает мусор.
 */

const GLUE_KEYS =
  "fp|security|alpn|sni|host|type|encryption|pbk|sid|flow|serviceName|headerType";

/** Допустимые отпечатки Xray; «unsafe» и мусор заменяем на chrome. */
const FP_ALLOWED = new Set([
  "chrome",
  "firefox",
  "safari",
  "ios",
  "android",
  "edge",
  "360",
  "qq",
  "random",
  "randomized",
]);

function decodeFully(value: string): string {
  // Двойное кодирование (%252F) ломает path: клиент видит «%2F», а не «/».
  let current = value;
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(current); i += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

export function normalizeVlessLink(input: string): string {
  const raw = (input ?? "").trim();
  if (!/^vless:\/\//i.test(raw)) return raw;

  const hashAt = raw.indexOf("#");
  const remark = hashAt >= 0 ? raw.slice(hashAt + 1) : "";
  const body = (hashAt >= 0 ? raw.slice(0, hashAt) : raw).slice("vless://".length);
  const qAt = body.indexOf("?");
  const authority = qAt >= 0 ? body.slice(0, qAt) : body;
  const query = qAt >= 0 ? body.slice(qAt + 1) : "";

  const at = authority.lastIndexOf("@");
  if (at <= 0) return raw;
  const uuid = authority.slice(0, at);
  const hostpart = authority.slice(at + 1);

  let host = "";
  let port = 443;

  if (hostpart.startsWith("[")) {
    const close = hostpart.indexOf("]");
    if (close < 0) return raw;
    host = hostpart.slice(1, close);
    const rest = hostpart.slice(close + 1);
    if (rest.startsWith(":")) port = Number(rest.slice(1)) || 443;
  } else {
    const parts = hostpart.split(":");
    if (parts.length === 2) {
      host = parts[0];
      port = Number(parts[1]) || 443;
    } else if (parts.length > 2) {
      // IPv6, записанный без скобок: последняя часть — порт, если это число.
      const last = parts[parts.length - 1];
      if (/^\d+$/.test(last) && parts.length > 3) {
        port = Number(last) || 443;
        host = parts.slice(0, -1).join(":");
      } else {
        host = hostpart;
      }
    } else {
      host = hostpart;
    }
  }
  if (!host) return raw;

  const params = new Map<string, string>();
  const set = (key: string, value: string) => {
    if (!params.has(key)) params.set(key, value);
  };

  const queue = query.split("&").filter(Boolean);
  while (queue.length > 0) {
    const chunk = queue.shift() as string;
    const eq = chunk.indexOf("=");
    const key = eq < 0 ? chunk : chunk.slice(0, eq);
    let value = eq < 0 ? "" : chunk.slice(eq + 1);

    // Склейка параметров: path=/?foo...fp=chrome приходит как один кусок.
    if (key === "path") {
      const glued = value.match(new RegExp(`^(.*?)(${GLUE_KEYS})=(.+)$`, "s"));
      if (glued && glued[1]) {
        value = glued[1];
        queue.unshift(`${glued[2]}=${glued[3]}`);
      }
      value = decodeFully(value);
      if (value && !value.startsWith("/")) value = `/${value}`;
      // Храним в единственном кодировании: клиент получит ровно то, что ждёт.
      set("path", encodeURIComponent(value));
      continue;
    }

    if (key === "fp" || key === "fingerprint") {
      const fp = value.toLowerCase();
      set("fp", FP_ALLOWED.has(fp) ? fp : "chrome");
      continue;
    }

    if (key === "security") {
      set("security", value.toLowerCase());
      continue;
    }

    set(key, value);
  }

  // Значения по умолчанию: без них часть клиентов ссылку не принимает.
  if (!params.has("encryption")) params.set("encryption", "none");
  if (!params.has("security") && params.has("pbk")) params.set("security", "reality");
  if (!params.has("type")) params.set("type", "tcp");

  const queryOut = Array.from(params.entries())
    .map(([key, value]) => (value === "" ? key : `${key}=${value}`))
    .join("&");

  const hostOut = host.includes(":") ? `[${host}]` : host;
  const tail = remark ? `#${remark}` : "";
  return `vless://${uuid}@${hostOut}:${port}?${queryOut}${tail}`;
}
