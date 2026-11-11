/**
 * Подписка в формате Xray JSON — «Автоматический выбор».
 *
 * В платных клиентах верхняя строка выглядит как один профиль «Автоматический
 * выбор» с подписью `VLESS | JSON`, а не как список стран. Внутри такого
 * профиля лежит полный конфиг Xray: десятки outbound'ов и балансировщик
 * leastPing с observatory — клиент сам проверяет узлы и уводит трафик на
 * живой, без ручного переключения.
 *
 * Список ссылок (base64) остаётся основным форматом: он работает в любом
 * клиенте. JSON — дополнительный профиль для Happ, где нужен автоподбор.
 */

interface VlessOutbound {
  tag: string;
  protocol: "vless";
  settings: {
    vnext: Array<{
      address: string;
      port: number;
      users: Array<{ id: string; encryption: "none"; flow: string }>;
    }>;
  };
  streamSettings: Record<string, unknown>;
}

function streamSettings(url: URL): Record<string, unknown> {
  const p = url.searchParams;
  const network = p.get("type") || "tcp";
  const security = p.get("security") || "none";
  const sni = p.get("sni") || p.get("host") || url.hostname;
  const fp = p.get("fp") || "chrome";

  const stream: Record<string, unknown> = { network, security };

  if (security === "reality") {
    stream.realitySettings = {
      serverName: sni,
      fingerprint: fp,
      publicKey: p.get("pbk") ?? "",
      shortId: p.get("sid") ?? "",
      spiderX: p.get("spx") ?? "/",
    };
  } else if (security === "tls") {
    const alpn = p.get("alpn");
    stream.tlsSettings = {
      serverName: sni,
      fingerprint: fp,
      allowInsecure: false,
      ...(alpn ? { alpn: alpn.split(",") } : {}),
    };
  }

  if (network === "ws") {
    stream.wsSettings = {
      path: p.get("path") || "/",
      headers: { Host: p.get("host") || sni },
    };
  } else if (network === "grpc") {
    stream.grpcSettings = { serviceName: p.get("serviceName") || "" };
  } else if (network === "xhttp" || network === "splithttp") {
    // XHTTP из панели часто идёт с extra: xmux и паддинг. Без них часть
    // серверов принимает соединение и молча не пропускает данные, поэтому
    // переносим объект как есть.
    const extraRaw = p.get("extra");
    let extra: Record<string, unknown> | null = null;
    if (extraRaw) {
      try {
        const parsed = JSON.parse(extraRaw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          extra = parsed as Record<string, unknown>;
        }
      } catch {
        // битый extra — соединение всё равно попробуем
      }
    }
    stream.xhttpSettings = {
      path: p.get("path") || "/",
      host: p.get("host") || "",
      mode: p.get("mode") || "auto",
      ...(extra ? { extra } : {}),
    };
  } else if (network === "tcp" && (p.get("headerType") || "") === "http") {
    stream.tcpSettings = {
      header: { type: "http", request: { path: [p.get("path") || "/"], headers: { Host: [p.get("host") || sni] } } },
    };
  }

  return stream;
}

/** Подпись узла из фрагмента ссылки — она же имя профиля в клиенте. */
function tagOf(uri: string, index: number): string {
  const hash = uri.indexOf("#");
  if (hash >= 0) {
    try {
      const label = decodeURIComponent(uri.slice(hash + 1)).trim();
      if (label) return label;
    } catch {
      // битая метка — остаётся техническое имя
    }
  }
  return `proxy-${index}`;
}

/** Один vless-узел в виде outbound. */
export function toOutbound(uri: string, index: number): VlessOutbound | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== "vless:") return null;
    const id = decodeURIComponent(url.username);
    if (!id) return null;
    const port = Number(url.port) || 443;
    return {
      tag: tagOf(uri, index),
      protocol: "vless",
      settings: {
        vnext: [
          {
            address: url.hostname,
            port,
            users: [{ id, encryption: "none", flow: url.searchParams.get("flow") ?? "" }],
          },
        ],
      },
      streamSettings: streamSettings(url),
    };
  } catch {
    return null;
  }
}

/**
 * Полный конфиг «Автоматический выбор».
 *
 * Балансировщик leastPing поверх observatory: клиент сам замеряет задержку
 * до каждого outbound и отправляет новый поток на самый быстрый живой.
 * `strategySettings` не задаём — для leastPing он не нужен.
 */
export function buildAutoConfig(uris: string[], limit = 25): string {
  const outbounds = uris
    .slice(0, limit)
    .map((uri, index) => toOutbound(uri, index))
    .filter((item): item is VlessOutbound => item !== null);

  // Имена профилей в клиенте — это теги outbound'ов. Берём их из подписи
  // ссылки, а селектор балансировщика перечисляет теги явно: префикс
  // «proxy-» перестал быть общим после перехода на человеческие имена.
  const seen = new Set<string>();
  for (const item of outbounds) {
    let tag = item.tag;
    let n = 2;
    while (seen.has(tag)) tag = `${item.tag} #${n++}`;
    item.tag = tag;
    seen.add(tag);
  }
  const tags = outbounds.map((item) => item.tag);

  const config = {
    log: { loglevel: "warning" },
    inbounds: [
      {
        tag: "socks-in",
        listen: "127.0.0.1",
        port: 10808,
        protocol: "socks",
        settings: { auth: "noauth", udp: true },
        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"] },
      },
      {
        tag: "http-in",
        listen: "127.0.0.1",
        port: 10809,
        protocol: "http",
        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"] },
      },
    ],
    outbounds: [
      ...outbounds,
      { tag: "direct", protocol: "freedom", settings: {} },
      { tag: "block", protocol: "blackhole", settings: {} },
    ],
    routing: {
      domainStrategy: "IPIfNonMatch",
      rules: [
        { type: "field", network: "tcp,udp", balancerTag: "auto" },
      ],
      balancers: [
        { tag: "auto", selector: tags, strategy: { type: "leastPing" } },
      ],
    },
    observatory: {
      subjectSelector: tags,
      probeUrl: "https://www.gstatic.com/generate_204",
      probeInterval: "30s",
      enableConcurrency: true,
    },
  };

  return JSON.stringify(config, null, 2);
}
