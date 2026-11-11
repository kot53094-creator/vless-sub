/**
 * Подписка в формате sing-box — «Автоматический выбор».
 *
 * Happ построен на sing-box, а не на Xray: конфиг Xray он не разбирает и
 * берёт из него первый outbound, из-за чего вместо списка появлялся один
 * прокси. Здесь та же идея, но в родной для клиента схеме:
 *
 *   • outbounds типа vless — по одному на узел;
 *   • urltest-группа "auto" — клиент сам замеряет задержку и держит трафик
 *     на самом быстром живом узле;
 *   • selector "select" — то, что видно в интерфейсе как «Автоматический
 *     выбор»; по умолчанию указывает на "auto".
 *
 * Параметры узла переносятся один в один: REALITY, TLS, WS, gRPC, xhttp.
 */

interface SingOutbound {
  type: string;
  tag: string;
  [key: string]: unknown;
}

/**
 * Человеческое имя узла.
 *
 * sing-box показывает в интерфейсе поле tag, а не адрес. Пока теги были
 * proxy-1..3, в Happ висели безымянные строки; берём метку из ссылки —
 * там уже страна, город и пинг.
 */
function nameFromUri(uri: string, index: number): string {
  const hash = uri.includes("#") ? uri.split("#").slice(1).join("#") : "";
  let label = hash;
  try {
    label = decodeURIComponent(hash);
  } catch {
    // битая метка — останется как есть
  }
  label = label.trim();
  if (!label) return `Сервер ${index + 1}`;
  return label.slice(0, 48);
}

function proxyFromUri(uri: string, index: number): SingOutbound | null {
  try {
    const url = new URL(uri);
    if (url.protocol === "hysteria2:" || url.protocol === "hy2:") {
      const password = decodeURIComponent(url.username);
      if (!password) return null;
      const p = url.searchParams;
      const tls: Record<string, unknown> = {
        enabled: true,
        server_name: p.get("sni") || p.get("peer") || url.hostname,
        insecure: ["1", "true"].includes(String(p.get("insecure") ?? "1").toLowerCase()),
      };
      const alpn = p.get("alpn");
      if (alpn) tls.alpn = alpn.split(",").filter(Boolean);
      const out: SingOutbound = {
        type: "hysteria2",
        tag: nameFromUri(uri, index),
        server: url.hostname,
        server_port: Number(url.port) || 443,
        password,
        tls,
      };
      const obfs = p.get("obfs");
      if (obfs) {
        out.obfs = { type: obfs, password: p.get("obfs-password") ?? "" };
      }
      return out;
    }
    if (url.protocol !== "vless:") return null;
    const uuid = decodeURIComponent(url.username);
    if (!uuid) return null;

    const p = url.searchParams;
    const out: SingOutbound = {
      type: "vless",
      tag: "proxy",
      server: url.hostname,
      server_port: Number(url.port) || 443,
      uuid,
      packet_encoding: "xudp",
    };

    const flow = p.get("flow");
    if (flow) out.flow = flow;

    const security = p.get("security") || "none";
    const sni = p.get("sni") || p.get("host") || url.hostname;
    const fingerprint = p.get("fp") || "chrome";

    if (security === "tls" || security === "reality") {
      const tls: Record<string, unknown> = {
        enabled: true,
        server_name: sni,
        utls: { enabled: true, fingerprint },
      };
      if (security === "reality") {
        tls.reality = {
          enabled: true,
          public_key: p.get("pbk") ?? "",
          short_id: p.get("sid") ?? "",
        };
      } else if (p.get("alpn")) {
        tls.alpn = String(p.get("alpn")).split(",");
      }
      out.tls = tls;
    }

    const network = p.get("type") || "tcp";
    if (network === "ws") {
      out.transport = {
        type: "ws",
        path: p.get("path") || "/",
        headers: { Host: p.get("host") || sni },
      };
    } else if (network === "grpc") {
      out.transport = { type: "grpc", service_name: p.get("serviceName") || "" };
    } else if (network === "xhttp" || network === "splithttp") {
      out.transport = {
        type: "http",
        host: [p.get("host") || sni],
        path: p.get("path") || "/",
      };
    }

    out.tag = nameFromUri(uri, index);
    return out;
  } catch {
    return null;
  }
}

/**
 * Конфиг sing-box с автоматическим выбором узла.
 *
 * Inbound не описываем: Happ подставляет свой (tun/socks) при импорте, а
 * лишний tun в подписке только конфликтует с настройками приложения.
 */
export function buildSingBoxConfig(uris: string[], limit = 25): string {
  const proxies = uris
    .slice(0, limit)
    .map((uri, index) => proxyFromUri(uri, index))
    .filter((item): item is SingOutbound => item !== null);

  // Нумерация после фильтрации: пропущенный ss:// не должен оставлять дыру
  // в тегах, иначе urltest ссылается на несуществующий proxy-1.

  // Нумерация после фильтрации: пропущенный ss:// не должен оставлять дыру
  // в тегах, иначе urltest ссылается на несуществующий proxy-1.

  // Имена должны быть уникальны: одинаковый tag ломает urltest.
  const used = new Set<string>();
  proxies.forEach((proxy, index) => {
    const base = String(proxy.tag ?? "").trim() || `Сервер ${index + 1}`;
    let name = base;
    let suffix = 2;
    while (used.has(name)) {
      name = `${base} (${suffix})`;
      suffix += 1;
    }
    used.add(name);
    proxy.tag = name;
  });

  const tags = proxies.map((proxy) => proxy.tag);

  const config = {
    log: { level: "warn" },
    outbounds: [
      {
        type: "selector",
        tag: "select",
        outbounds: ["auto", ...tags, "direct"],
        default: "auto",
      },
      {
        type: "urltest",
        tag: "auto",
        outbounds: tags,
        url: "https://www.gstatic.com/generate_204",
        // Замер раз в минуту вместо трёх: узел, умерший на мобильном, должен
        // отваливаться быстро, иначе человек минутами смотрит на «нет сети».
        interval: "1m",
        // Разница меньше 30 мс не повод переключаться: иначе клиент дёргает
        // соединение между равными узлами и рвёт загрузки.
        tolerance: 30,
        idle_timeout: "10m",
        interrupt_exist_connections: false,
      },
      ...proxies,
      { type: "direct", tag: "direct" },
    ],
    route: {
      final: "select",
      auto_detect_interface: true,
    },
  };

  return JSON.stringify(config, null, 2);
}
