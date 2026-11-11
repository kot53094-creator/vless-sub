/**
 * Импорт разрешённых внешних подписок («второй контур»).
 *
 * Зачем отдельный модуль: основной пул живёт в D1 и пополняется проверками
 * из GitHub Actions. Внешние подписки — другое: их нельзя терять при
 * недоступности базы, они меняются без нашего участия и не должны зависеть
 * от суточной квоты D1. Поэтому объединённый список лежит в KV:
 *
 *   merge:pool:v1    — последний рабочий список узлов (JSON);
 *   merge:status:v1  — когда и что обновилось, ошибки источников;
 *   merge:off:v1     — источники, выключенные админом;
 *   merge:geo:<host> — кэш страны по адресу узла.
 *
 * Правило отказа: если источник не ответил или отдал заглушку, его узлы из
 * прошлой удачной версии остаются в подписке. Удаление — только когда
 * источник ответил и узла в нём больше нет.
 *
 * Ссылки источников и HWID живут в Cloudflare Secrets (MERGE_SOURCE_A/B/C,
 * MERGE_HWID), в репозиторий и логи они не попадают.
 */

import { flagOf, serverLabel } from "./labels";
import { parseUri } from "./parser";
import { envStr } from "./security";
import type { Env } from "./types";

export interface MergeNode {
  /** Стабильный идентификатор узла: хэш от протокола, адреса и параметров. */
  id: string;
  link: string;
  label: string;
  /** Короткая метка источника: A, B, C. */
  source: string;
  host: string;
  port: number;
  countryCode: string;
  countryName: string;
  city: string;
  status: "alive" | "dead" | "unknown";
  latencyMs: number | null;
  checkedAt: string | null;
  addedAt: string;
}

export interface MergeSourceStatus {
  key: string;
  label: string;
  ok: boolean;
  nodes: number;
  bytes: number;
  error: string | null;
  fetchedAt: string | null;
  disabled: boolean;
}

export interface MergeStatus {
  version: 1;
  /** Время последнего удачного обновления списка. */
  updatedAt: string | null;
  /** Время последней попытки (удачной или нет). */
  attemptAt: string | null;
  total: number;
  alive: number;
  dead: number;
  unknown: number;
  sources: MergeSourceStatus[];
}

const POOL_KEY = "merge:pool:v1";
const STATUS_KEY = "merge:status:v1";
const OFF_KEY = "merge:off:v1";
const GEO_TTL = 30 * 24 * 3600;
/** Синхронизация не чаще раза в 30 минут: так просил владелец. */
const SYNC_INTERVAL_MS = 30 * 60 * 1000;
/** Сколько новых гео-запросов за прогон: бережём подзапросы воркера. */
const GEO_LOOKUPS_PER_RUN = 12;
const MAX_NODES = 120;
const FETCH_TIMEOUT_MS = 20_000;
/** Источники, которые уже замечены как «лимит устройств» в этой сети. */
const STUB_HOSTS = new Set(["0.0.0.0", "127.0.0.1", "localhost", "::1"]);

const SOURCES: Array<{ key: "A" | "B" | "C"; label: string }> = [
  { key: "A", label: "Источник A" },
  { key: "B", label: "Источник B" },
  { key: "C", label: "Источник C" },
];

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Dict)
    : null;
}

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hostPort(address: string, port: number): string {
  const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  return `${host}:${port}`;
}

/* ── Разбор форматов источников ────────────────────────────────────────── */

/**
 * Xray-конфиг (или массив конфигов) → ссылки vless://.
 *
 * Раньше считалось, что источники отдают только base64-список. На деле
 * панель под UA Happ отдаёт массив полных Xray-конфигов: в первом лежат все
 * узлы, остальные — по одному на профиль. Поэтому разбираем любую форму.
 */
function xrayOutboundToUri(raw: Dict): string | null {
  if (str(raw.protocol).toLowerCase() !== "vless") return null;
  const settings = asDict(raw.settings);
  const vnext = Array.isArray(settings?.vnext) ? (settings?.vnext as unknown[]) : [];
  const first = asDict(vnext[0]);
  if (!first) return null;
  const address = str(first.address);
  const port = num(first.port);
  if (!address || !port || STUB_HOSTS.has(address.toLowerCase())) return null;
  const users = Array.isArray(first.users) ? (first.users as unknown[]) : [];
  const user = asDict(users[0]);
  const id = str(user?.id);
  if (!id) return null;

  const stream = asDict(raw.streamSettings) ?? {};
  const network = str(stream.network).toLowerCase() || "tcp";
  const security = str(stream.security).toLowerCase() || "none";
  const params = new URLSearchParams({ encryption: "none" });
  if (network !== "tcp") params.set("type", network);
  const flow = str(user?.flow);
  if (flow) params.set("flow", flow);

  if (security === "reality") {
    const reality = asDict(stream.realitySettings) ?? {};
    const sni = str(reality.serverName) || address;
    params.set("security", "reality");
    params.set("sni", sni);
    params.set("fp", str(reality.fingerprint) || "chrome");
    const pbk = str(reality.publicKey);
    if (pbk) params.set("pbk", pbk);
    const sid = str(reality.shortId);
    if (sid) params.set("sid", sid);
    const spx = str(reality.spiderX);
    if (spx && spx !== "/") params.set("spx", spx);
  } else if (security === "tls") {
    const tls = asDict(stream.tlsSettings) ?? {};
    params.set("security", "tls");
    params.set("sni", str(tls.serverName) || address);
    const fp = str(tls.fingerprint);
    if (fp) params.set("fp", fp);
    const alpn = Array.isArray(tls.alpn) ? tls.alpn.map((item) => str(item)).filter(Boolean) : [];
    if (alpn.length) params.set("alpn", alpn.join(","));
    if (tls.allowInsecure === true) params.set("allowInsecure", "1");
    if (tls.insecure === true) params.set("allowInsecure", "1");
  }

  if (network === "ws") {
    const ws = asDict(stream.wsSettings) ?? {};
    params.set("path", str(ws.path) || "/");
    const headers = asDict(ws.headers);
    const host = str(headers?.Host) || str(headers?.host);
    if (host) params.set("host", host);
  } else if (network === "grpc") {
    const grpc = asDict(stream.grpcSettings) ?? {};
    const service = str(grpc.serviceName);
    if (service) params.set("serviceName", service);
    if (grpc.multiMode === true) params.set("mode", "multi");
  } else if (network === "xhttp" || network === "splithttp") {
    const xhttp = asDict(stream.xhttpSettings) ?? {};
    params.set("path", str(xhttp.path) || "/");
    const host = str(xhttp.host);
    if (host) params.set("host", host);
    const mode = str(xhttp.mode);
    if (mode && mode !== "auto") params.set("mode", mode);
    const extra = asDict(xhttp.extra);
    if (extra && Object.keys(extra).length > 0) {
      // xmux/паддинг: необязательная оптимизация, клиенты без поддержки
      // параметра просто её проигнорируют.
      try {
        params.set("extra", JSON.stringify(extra));
      } catch {
        // extra остаётся неописанным — соединение это не ломает
      }
    }
  } else if (network === "tcp") {
    const tcp = asDict(stream.tcpSettings);
    const header = asDict(tcp?.header);
    if (str(header?.type).toLowerCase() === "http") {
      const request = asDict(header?.request) ?? {};
      const pathValue = Array.isArray(request.path) ? str((request.path as unknown[])[0]) : str(request.path);
      params.set("headerType", "http");
      params.set("path", pathValue || "/");
      const headers = asDict(request.headers);
      const host = Array.isArray(headers?.Host) ? str((headers?.Host as unknown[])[0]) : str(headers?.Host);
      if (host) params.set("host", host);
    }
  } else if (network === "h2") {
    const h2 = asDict(stream.httpSettings) ?? {};
    params.set("path", str(h2.path) || "/");
    const host = Array.isArray(h2.host) ? str((h2.host as unknown[])[0]) : str(h2.host);
    if (host) params.set("host", host);
  }

  const tag = str(raw.tag);
  const query = params.toString();
  const fragment = tag ? `#${encodeURIComponent(tag)}` : "";
  return `vless://${encodeURIComponent(id)}@${hostPort(address, port)}?${query}${fragment}`;
}

/** sing-box outbound → ссылка (на случай, если источник сменит шаблон). */
function singboxOutboundToUri(raw: Dict): string | null {
  const type = str(raw.type).toLowerCase();
  if (type !== "vless") return null;
  const address = str(raw.server);
  const port = num(raw.server_port ?? raw.port);
  const id = str(raw.uuid);
  if (!address || !port || !id || STUB_HOSTS.has(address.toLowerCase())) return null;
  const params = new URLSearchParams({ encryption: "none" });
  const flow = str(raw.flow);
  if (flow) params.set("flow", flow);
  const tls = asDict(raw.tls) ?? {};
  const reality = asDict(tls.reality);
  const utls = asDict(tls.utls);
  const transport = asDict(raw.transport) ?? {};
  const network = str(transport.type).toLowerCase() || "tcp";
  if (network !== "tcp") params.set("type", network);
  if (reality) {
    params.set("security", "reality");
    params.set("sni", str(tls.server_name) || address);
    params.set("fp", str(utls?.fingerprint) || "chrome");
    const pbk = str(reality.public_key);
    if (pbk) params.set("pbk", pbk);
    const sid = str(reality.short_id);
    if (sid) params.set("sid", sid);
  } else if (tls.enabled === true) {
    params.set("security", "tls");
    params.set("sni", str(tls.server_name) || address);
    const fp = str(utls?.fingerprint);
    if (fp) params.set("fp", fp);
    if (tls.insecure === true) params.set("allowInsecure", "1");
  }
  if (network === "ws") {
    params.set("path", str(transport.path) || "/");
    const headers = asDict(transport.headers);
    const host = str(headers?.Host) || str(headers?.host);
    if (host) params.set("host", host);
  } else if (network === "grpc") {
    const service = str(transport.service_name);
    if (service) params.set("serviceName", service);
  } else if (network === "httpupgrade" || network === "xhttp") {
    params.set("type", "xhttp");
    params.set("path", str(transport.path) || "/");
    const host = str(transport.host);
    if (host) params.set("host", host);
  }
  const tag = str(raw.tag);
  const fragment = tag ? `#${encodeURIComponent(tag)}` : "";
  return `vless://${encodeURIComponent(id)}@${hostPort(address, port)}?${params.toString()}${fragment}`;
}

/* ── Clash YAML (только блок proxies) ──────────────────────────────────── */

interface YamlLine {
  indent: number;
  text: string;
}

function yamlLines(source: string): YamlLine[] {
  const out: YamlLine[] = [];
  for (const raw of source.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    out.push({ indent, text: raw.trim() });
  }
  return out;
}

function yamlScalar(value: string): unknown {
  const text = value.trim();
  if (!text) return "";
  if (text.startsWith("{") && text.endsWith("}")) {
    const inner = text.slice(1, -1).trim();
    const map: Dict = {};
    for (const part of splitFlow(inner)) {
      const idx = part.indexOf(":");
      if (idx < 0) continue;
      map[unquote(part.slice(0, idx))] = yamlScalar(part.slice(idx + 1));
    }
    return map;
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    return splitFlow(text.slice(1, -1).trim()).map((part) => yamlScalar(part));
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return unquote(text);
}

function unquote(value: string): string {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

/** Запятые верхнего уровня: внутри вложенных {} и [] не считаются. */
function splitFlow(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseYamlBlock(lines: YamlLine[], start: number, indent: number): [unknown, number] {
  if (start >= lines.length) return [null, start];
  const isList = lines[start].text.startsWith("-");
  const result: unknown = isList ? [] : {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent !== indent) break;
    if (!isList && line.text.startsWith("-")) break;
    if (isList && !line.text.startsWith("-")) break;
    if (isList) {
      const body = line.text.slice(1).trim();
      const list = result as unknown[];
      if (!body) {
        const next = lines[i + 1];
        if (next && next.indent > indent) {
          const [value, after] = parseYamlBlock(lines, i + 1, next.indent);
          list.push(value);
          i = after;
        } else {
          list.push(null);
          i += 1;
        }
        continue;
      }
      if (body.includes(":")) {
        const map: Dict = {};
        const idx = body.indexOf(":");
        map[unquote(body.slice(0, idx))] = yamlScalar(body.slice(idx + 1));
        const next = lines[i + 1];
        if (next && next.indent > indent) {
          const [rest, after] = parseYamlBlock(lines, i + 1, next.indent);
          if (asDict(rest)) Object.assign(map, rest as Dict);
          i = after;
        } else {
          i += 1;
        }
        list.push(map);
        continue;
      }
      list.push(yamlScalar(body));
      i += 1;
      continue;
    }
    const map = result as Dict;
    const idx = line.text.indexOf(":");
    if (idx < 0) {
      i += 1;
      continue;
    }
    const key = unquote(line.text.slice(0, idx));
    const tail = line.text.slice(idx + 1).trim();
    if (tail) {
      map[key] = yamlScalar(tail);
      i += 1;
      continue;
    }
    const next = lines[i + 1];
    if (next && next.indent > indent) {
      const [value, after] = parseYamlBlock(lines, i + 1, next.indent);
      map[key] = value;
      i = after;
    } else {
      map[key] = null;
      i += 1;
    }
  }
  return [result, i];
}

function clashProxyToUri(raw: Dict): string | null {
  const type = str(raw.type).toLowerCase();
  if (type !== "vless") return null;
  const address = str(raw.server);
  const port = num(raw.port);
  const id = str(raw.uuid);
  if (!address || !port || !id || STUB_HOSTS.has(address.toLowerCase())) return null;
  const params = new URLSearchParams({ encryption: "none" });
  const network = str(raw.network).toLowerCase() || "tcp";
  if (network !== "tcp") params.set("type", network);
  const reality = asDict(raw["reality-opts"]);
  const tls = raw.tls === true;
  if (reality) {
    params.set("security", "reality");
    params.set("sni", str(raw.servername) || str(raw.sni) || address);
    params.set("fp", str(raw["client-fingerprint"]) || "chrome");
    const pbk = str(reality["public-key"]);
    if (pbk) params.set("pbk", pbk);
    const sid = str(reality["short-id"]);
    if (sid) params.set("sid", sid);
  } else if (tls) {
    params.set("security", "tls");
    params.set("sni", str(raw.servername) || str(raw.sni) || address);
    const fp = str(raw["client-fingerprint"]);
    if (fp) params.set("fp", fp);
    if (raw["skip-cert-verify"] === true) params.set("allowInsecure", "1");
  }
  const flow = str(raw.flow);
  if (flow) params.set("flow", flow);
  if (network === "ws") {
    const ws = asDict(raw["ws-opts"]) ?? {};
    params.set("path", str(ws.path) || "/");
    const headers = asDict(ws.headers);
    const host = str(headers?.Host) || str(headers?.host);
    if (host) params.set("host", host);
  } else if (network === "grpc") {
    const grpc = asDict(raw["grpc-opts"]) ?? {};
    const service = str(grpc["grpc-service-name"]);
    if (service) params.set("serviceName", service);
  } else if (network === "xhttp") {
    const xhttp = asDict(raw["xhttp-opts"]) ?? {};
    params.set("path", str(xhttp.path) || "/");
    const host = str(xhttp.host);
    if (host) params.set("host", host);
  }
  const name = str(raw.name);
  const fragment = name ? `#${encodeURIComponent(name)}` : "";
  return `vless://${encodeURIComponent(id)}@${hostPort(address, port)}?${params.toString()}${fragment}`;
}

function clashUris(source: string): string[] {
  const lines = yamlLines(source);
  const start = lines.findIndex((line) => line.indent === 0 && /^proxies\s*:/.test(line.text));
  if (start < 0) return [];
  const tail = lines[start].text.slice(lines[start].text.indexOf(":") + 1).trim();
  let proxies: unknown = [];
  if (tail) {
    proxies = yamlScalar(tail);
  } else {
    const [value] = parseYamlBlock(lines, start + 1, lines[start + 1]?.indent ?? 2);
    proxies = value;
  }
  if (!Array.isArray(proxies)) return [];
  const out: string[] = [];
  for (const item of proxies) {
    const proxy = asDict(item);
    if (!proxy) continue;
    const uri = clashProxyToUri(proxy);
    if (uri) out.push(uri);
  }
  return out;
}

/* ── Общий разбор ответа источника ─────────────────────────────────────── */

const URI_RE = /^(vless|vmess|trojan|ss|hysteria2|hy2):\/\//i;

function uriLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (URI_RE.test(line)) out.push(line);
  }
  return out;
}

function fromJsonDoc(doc: unknown): string[] {
  const configs = Array.isArray(doc) ? doc : [doc];
  const out: string[] = [];
  for (const raw of configs) {
    const config = asDict(raw);
    if (!config) continue;
    const outbounds = Array.isArray(config.outbounds) ? (config.outbounds as unknown[]) : [];
    for (const item of outbounds) {
      const outbound = asDict(item);
      if (!outbound) continue;
      const uri = outbound.protocol
        ? xrayOutboundToUri(outbound)
        : outbound.type
          ? singboxOutboundToUri(outbound)
          : null;
      if (uri) out.push(uri);
    }
  }
  return out;
}

export function base64Decoded(text: string): string | null {
  const compact = text.replace(/\s+/g, "");
  if (!compact) return null;
  const padded = compact + "=".repeat((4 - (compact.length % 4)) % 4);
  try {
    return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
}

/** Заглушка панели: 0.0.0.0/127.0.0.1 с подписью «App not supported». */
export function isStubUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    return STUB_HOSTS.has(url.hostname.toLowerCase().replace(/^\[|\]$/g, ""));
  } catch {
    return true;
  }
}

/** Ответ источника в любом поддерживаемом формате → ссылки узлов. */
export function extractUris(payload: string): string[] {
  const text = payload.replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  const clean = (list: string[]) => list.filter((uri) => !isStubUri(uri));
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return clean(fromJsonDoc(JSON.parse(text)));
    } catch {
      // ниже попробуем как текст
    }
  }
  if (/^\s*proxies\s*:/m.test(text)) {
    const clash = clean(clashUris(text));
    if (clash.length) return clash;
  }
  const direct = clean(uriLines(text));
  if (direct.length) return direct;
  const decoded = base64Decoded(text);
  return decoded ? clean(uriLines(decoded)) : [];
}

/** Подпись заглушки из ответа панели: объясняет, почему узлов нет. */
function stubReason(payload: string): string {
  const text = payload.trim();
  const decoded = text.includes("://") ? text : (base64Decoded(text) ?? text);
  const labels: string[] = [];
  for (const line of decoded.split(/\r?\n/)) {
    const hash = line.indexOf("#");
    if (hash < 0) continue;
    try {
      const label = decodeURIComponent(line.slice(hash + 1)).trim();
      if (label && !labels.includes(label)) labels.push(label);
    } catch {
      // битая метка
    }
  }
  return labels.slice(0, 2).join(" / ");
}

/* ── Ключи, дедупликация, метаданные ───────────────────────────────────── */

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Отпечаток узла: одинаковые параметры = один узел, даже если тег другой. */
export function nodeFingerprint(link: string): string {
  try {
    const url = new URL(link);
    const p = url.searchParams;
    return [
      url.protocol.replace(":", ""),
      url.hostname.toLowerCase(),
      url.port || "443",
      decodeURIComponent(url.username),
      p.get("type") ?? "tcp",
      p.get("security") ?? "none",
      p.get("sni") ?? "",
      p.get("path") ?? "",
      p.get("serviceName") ?? "",
      p.get("pbk") ?? "",
    ].join("|");
  } catch {
    return link.slice(0, 120);
  }
}

function endpointKey(link: string): string {
  try {
    const url = new URL(link);
    return `${url.hostname.toLowerCase()}:${url.port || "443"}`;
  } catch {
    return "";
  }
}

function transportLabel(link: string): string {
  try {
    const url = new URL(link);
    const network = (url.searchParams.get("type") ?? "tcp").toLowerCase();
    const security = (url.searchParams.get("security") ?? "none").toLowerCase();
    const chain = `VLESS ${network === "tcp" ? "TCP" : network.toUpperCase()}`;
    return security === "reality" ? `${chain} Reality` : security === "tls" ? `${chain} TLS` : chain;
  } catch {
    return "VLESS";
  }
}

/** Человеческое имя узла: флаг, страна, город, пинг, транспорт, источник. */
function labelFor(node: MergeNode): string {
  const parsed = parseUri(node.link);
  if (!parsed) return `${node.countryName || node.host} · ${transportLabel(node.link)}`;
  const base = serverLabel(
    null,
    parsed,
    1,
    undefined,
    { country: node.countryName, city: node.city, code: node.countryCode },
    node.host,
    node.latencyMs,
    null,
  );
  return `${base} · ${node.source}`;
}

/* ── KV ────────────────────────────────────────────────────────────────── */

async function readNodes(env: Env): Promise<MergeNode[]> {
  try {
    const raw = await env.CACHE.get<MergeNode[]>(POOL_KEY, "json");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function readStatus(env: Env): Promise<MergeStatus | null> {
  try {
    return await env.CACHE.get<MergeStatus>(STATUS_KEY, "json");
  } catch {
    return null;
  }
}

async function readDisabled(env: Env): Promise<string[]> {
  try {
    const raw = await env.CACHE.get<string[]>(OFF_KEY, "json");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export async function mergedNodes(env: Env): Promise<MergeNode[]> {
  return readNodes(env);
}

export async function mergeStatus(env: Env): Promise<MergeStatus | null> {
  return readStatus(env);
}

export async function setMergeDisabled(env: Env, key: string, disabled: boolean): Promise<void> {
  const current = new Set(await readDisabled(env));
  if (disabled) current.add(key);
  else current.delete(key);
  await env.CACHE.put(OFF_KEY, JSON.stringify([...current]));
}

/* ── Гео ───────────────────────────────────────────────────────────────── */

async function geoOf(env: Env, host: string): Promise<{ cc: string; country: string; city: string } | null> {
  const cacheKey = `merge:geo:${host.toLowerCase()}`;
  try {
    const cached = await env.CACHE.get<{ cc: string; country: string; city: string }>(cacheKey, "json");
    if (cached && cached.cc) return cached;
  } catch {
    // кэш недоступен — идём в справочник
  }
  const probes = [
    `https://ipwho.is/${encodeURIComponent(host)}?fields=success,country,country_code,city`,
    `http://ip-api.com/json/${encodeURIComponent(host)}?fields=status,country,countryCode,city`,
  ];
  for (const url of probes) {
    try {
      const res = await fetch(url, { cf: { cacheTtl: 3600 } });
      if (!res.ok) continue;
      const data = (await res.json()) as Dict;
      const cc = str(data.country_code ?? data.countryCode).toUpperCase();
      if (!cc) continue;
      const info = { cc, country: str(data.country), city: str(data.city) };
      try {
        await env.CACHE.put(cacheKey, JSON.stringify(info), { expirationTtl: GEO_TTL });
      } catch {
        // без кэша
      }
      return info;
    } catch {
      // следующий справочник
    }
  }
  return null;
}

/* ── Синхронизация ─────────────────────────────────────────────────────── */

interface FetchResult {
  nodes: MergeNode[];
  bytes: number;
  error: string | null;
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSource(
  env: Env,
  slot: { key: string; label: string },
  url: string,
  previous: Map<string, MergeNode>,
): Promise<FetchResult> {
  const headers: Record<string, string> = {
    "User-Agent": envStr(env.FETCH_UA) || "Happ/2.9.1",
    Accept: "*/*",
  };
  // Панели Remnawave проверяют устройство: без HWID отдают заглушку
  // «App not supported», с чужим HWID — «Превышен лимит устройств».
  const hwid = envStr(env.MERGE_HWID);
  if (hwid) {
    headers["x-hwid"] = hwid;
    headers["x-device-os"] = "Android";
    headers["x-ver-os"] = "14";
    headers["x-device-model"] = "Pixel 7";
  }
  try {
    const res = await withTimeout((signal) => fetch(url, { headers, redirect: "follow", signal }));
    if (!res.ok) {
      return { nodes: [], bytes: 0, error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    const uris = extractUris(text);
    if (uris.length === 0) {
      const reason = stubReason(text) || "источник не отдал ни одного узла";
      return { nodes: [], bytes: text.length, error: reason.slice(0, 160) };
    }
    const nodes: MergeNode[] = [];
    const seen = new Set<string>();
    for (const link of uris) {
      const fingerprint = nodeFingerprint(link);
      if (seen.has(fingerprint)) continue;
      const parsed = parseUri(link);
      if (!parsed) continue;
      seen.add(fingerprint);
      // Гео и результат прошлой проверки переносим по отпечатку: иначе
      // каждая синхронизация начинала бы с «не проверен, страна неизвестна»
      // и сжигала лимит гео-запросов заново.
      const old = previous.get(fingerprint);
      nodes.push({
        id: fnv1a(fingerprint),
        link,
        label: old?.label ?? "",
        source: slot.key,
        host: parsed.host,
        port: parsed.port,
        countryCode: old?.countryCode ?? "",
        countryName: old?.countryName ?? "",
        city: old?.city ?? "",
        status: old?.status ?? "unknown",
        latencyMs: old?.latencyMs ?? null,
        checkedAt: old?.checkedAt ?? null,
        addedAt: old?.addedAt ?? new Date().toISOString(),
      });
    }
    if (nodes.length === 0) {
      return { nodes: [], bytes: text.length, error: "узлы не распознаны" };
    }
    return { nodes, bytes: text.length, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      nodes: [],
      bytes: 0,
      error: message.includes("abort") ? "таймаут ответа" : message.slice(0, 160),
    };
  }
}

/**
 * Синхронизировать объединённый список.
 *
 * force=true — ручной запуск из админки; иначе действует интервал 30 минут.
 * Возвращает актуальный статус.
 */
export async function syncMerge(env: Env, force = false): Promise<MergeStatus> {
  const previous = await readStatus(env);
  const previousNodes = await readNodes(env);
  const now = Date.now();
  if (
    !force &&
    previous?.attemptAt &&
    Number.isFinite(Date.parse(previous.attemptAt)) &&
    now - Date.parse(previous.attemptAt) < SYNC_INTERVAL_MS
  ) {
    return previous;
  }

  const disabled = new Set(await readDisabled(env));
  const previousByFingerprint = new Map<string, MergeNode>();
  for (const node of previousNodes) previousByFingerprint.set(nodeFingerprint(node.link), node);
  const sources: MergeSourceStatus[] = [];
  const collected: MergeNode[] = [];
  const bySource = new Map<string, MergeNode[]>();
  for (const node of previousNodes) {
    if (!bySource.has(node.source)) bySource.set(node.source, []);
    bySource.get(node.source)!.push(node);
  }

  for (const slot of SOURCES) {
    const url = envStr((env as unknown as Record<string, string | undefined>)[`MERGE_SOURCE_${slot.key}`]);
    const isOff = disabled.has(slot.key);
    if (!url || isOff) {
      // Источник выключен или не настроен: его прошлые узлы остаются в списке
      // только если он выключен вручную. Ненастроенный источник ничего не даёт.
      if (isOff) collected.push(...(bySource.get(slot.key) ?? []));
      sources.push({
        key: slot.key,
        label: slot.label,
        ok: isOff,
        nodes: bySource.get(slot.key)?.length ?? 0,
        bytes: 0,
        error: url ? "выключен в админке" : "не настроен (нет секрета)",
        fetchedAt: previous?.sources.find((item) => item.key === slot.key)?.fetchedAt ?? null,
        disabled: isOff,
      });
      continue;
    }
    const result = await fetchSource(env, slot, url, previousByFingerprint);
    if (result.error) {
      // Главное правило: сбой источника не удаляет его узлы.
      const kept = bySource.get(slot.key) ?? [];
      collected.push(...kept);
      sources.push({
        key: slot.key,
        label: slot.label,
        ok: false,
        nodes: kept.length,
        bytes: result.bytes,
        error: result.error,
        fetchedAt: previous?.sources.find((item) => item.key === slot.key)?.fetchedAt ?? null,
        disabled: false,
      });
      continue;
    }
    collected.push(...result.nodes);
    sources.push({
      key: slot.key,
      label: slot.label,
      ok: true,
      nodes: result.nodes.length,
      bytes: result.bytes,
      error: null,
      fetchedAt: new Date().toISOString(),
      disabled: false,
    });
  }

  // Дедупликация между источниками: один узел мог прийти из двух подписок.
  const seen = new Set<string>();
  const unique: MergeNode[] = [];
  for (const node of collected) {
    const fingerprint = nodeFingerprint(node.link);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    unique.push(node);
  }

  // Гео: определяем страну по адресу, а не по тегу источника.
  let lookups = 0;
  for (const node of unique) {
    if (node.countryCode && node.countryName) continue;
    const geo = lookups < GEO_LOOKUPS_PER_RUN ? await geoOf(env, node.host) : null;
    if (geo) {
      node.countryCode = geo.cc;
      node.countryName = geo.country;
      node.city = geo.city;
      lookups += 1;
    } else if (lookups < GEO_LOOKUPS_PER_RUN) {
      lookups += 1;
    }
    node.label = labelFor(node);
  }

  // Порядок: проверенные и быстрые — выше. Непроверенные не выбрасываем:
  // проверку делает агент, а до его ответа узел ещё может быть рабочим.
  unique.sort((a, b) => {
    const rank = (node: MergeNode) => (node.status === "alive" ? 0 : node.status === "dead" ? 2 : 1);
    return (
      rank(a) - rank(b) ||
      (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9) ||
      a.host.localeCompare(b.host) ||
      a.port - b.port
    );
  });
  const nodes = unique.slice(0, MAX_NODES);

  const status: MergeStatus = {
    version: 1,
    updatedAt: sources.some((item) => item.ok) ? new Date().toISOString() : (previous?.updatedAt ?? null),
    attemptAt: new Date().toISOString(),
    total: nodes.length,
    alive: nodes.filter((node) => node.status === "alive").length,
    dead: nodes.filter((node) => node.status === "dead").length,
    unknown: nodes.filter((node) => node.status === "unknown").length,
    sources,
  };

  try {
    await env.CACHE.put(POOL_KEY, JSON.stringify(nodes));
    await env.CACHE.put(STATUS_KEY, JSON.stringify(status));
    // Сброс кэша подписки: новые узлы должны появиться сразу, а не через
    // 15 минут (эпоха ротации), даже если D1 сейчас недоступна.
    await env.CACHE.put("pool:stamp", String(Date.now()));
  } catch {
    // KV недоступен — подписка продолжит работать на прошлой версии
  }
  return status;
}

/** Синк по расписанию: не чаще раза в 30 минут, без ручного флага. */
export async function syncMergeIfDue(env: Env): Promise<void> {
  try {
    await syncMerge(env, false);
  } catch {
    // cron не должен падать из-за источника
  }
}

/* ── Результаты проверки от агента ─────────────────────────────────────── */

export interface MergeCheckResult {
  id: string;
  ok: boolean;
  latencyMs?: number | null;
  /**
   * Мягкий провал: узел не прошёл проверку из-за транспорта (xhttp/grpc
   * сквозь CDN), а не потому, что сервер мёртв. Такой узел остаётся
   * «не проверенным» — выкидывать его из подписки нельзя.
   */
  soft?: boolean;
}

/** Применить результаты настоящей проверки через Xray (GitHub Actions). */
export async function applyMergeChecks(env: Env, results: MergeCheckResult[]): Promise<number> {
  const nodes = await readNodes(env);
  if (nodes.length === 0) return 0;
  const byId = new Map(results.map((item) => [item.id, item]));
  const now = new Date().toISOString();
  let updated = 0;
  for (const node of nodes) {
    const result = byId.get(node.id);
    if (!result) continue;
    if (!result.ok && result.soft) {
      node.status = "unknown";
      node.latencyMs = null;
    } else {
      node.status = result.ok ? "alive" : "dead";
      node.latencyMs = result.ok ? (result.latencyMs ?? null) : null;
    }
    node.checkedAt = now;
    node.label = labelFor(node);
    updated += 1;
  }
  const status = await readStatus(env);
  const alive = nodes.filter((node) => node.status === "alive").length;
  const dead = nodes.filter((node) => node.status === "dead").length;
  try {
    await env.CACHE.put(POOL_KEY, JSON.stringify(nodes));
    if (status) {
      await env.CACHE.put(STATUS_KEY, JSON.stringify({
        ...status,
        alive,
        dead,
        unknown: nodes.length - alive - dead,
      }));
    }
    await env.CACHE.put("pool:stamp", String(Date.now()));
  } catch {
    // следующий прогон повторит
  }
  return updated;
}

/* ── Выдача в подписке ─────────────────────────────────────────────────── */

/**
 * Добавить импортированные узлы в список подписки.
 *
 * Дубли по паре host:port убираются: в клиенте это выглядели бы как две
 * одинаковые строки с разными подписями. Мёртвые (по проверке агента) не
 * выдаются, но остаются в статусе админки.
 */
export async function appendMergedLinks(env: Env, uris: string[]): Promise<number> {
  if ((env.MERGE_ENABLED ?? "1") === "0") return 0;
  const nodes = await readNodes(env);
  if (nodes.length === 0) return 0;
  const used = new Set<string>();
  for (const uri of uris) {
    const key = endpointKey(uri);
    if (key) used.add(key);
  }
  const anchorHosts = new Set(uris.map((uri) => endpointKey(uri)).filter(Boolean));
  let added = 0;
  for (const node of nodes) {
    if (added >= 60) break;
    if (node.status === "dead") continue;
    const key = endpointKey(node.link);
    if (!key || used.has(key) || anchorHosts.has(key)) continue;
    used.add(key);
    const label = node.label || `${node.countryName || node.host} · ${transportLabel(node.link)} · ${node.source}`;
    uris.push(
      `${node.link.split("#")[0]}#${encodeURIComponent(label)}`,
    );
    added += 1;
  }
  return added;
}

/** Флаг страны узла для сортировки/группировки в админке. */
export function mergeFlag(node: MergeNode): string {
  return flagOf(node.countryCode);
}
