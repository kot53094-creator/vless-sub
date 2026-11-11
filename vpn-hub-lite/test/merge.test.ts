import { describe, expect, it } from "vitest";

import {
  appendMergedLinks,
  extractUris,
  nodeFingerprint,
  syncMerge,
} from "../src/merge";
import type { Env } from "../src/types";
import { buildAutoConfig } from "../src/xray_json";

const XHTTP = {
  tag: "fi",
  protocol: "vless",
  settings: {
    vnext: [
      {
        address: "192.71.247.209",
        port: 8443,
        users: [{ id: "11111111-2222-3333-4444-555555555555", encryption: "none", flow: "" }],
      },
    ],
  },
  streamSettings: {
    network: "xhttp",
    security: "reality",
    xhttpSettings: { mode: "packet-up", path: "/assets/v2/stream", extra: { xPaddingBytes: "20-160" } },
    realitySettings: {
      serverName: "cdn.example.com",
      publicKey: "PUBKEY",
      shortId: "ab12",
      fingerprint: "firefox",
    },
  },
};

describe("импорт внешних подписок", () => {
  it("превращает Xray-outbound в ссылку без потери параметров", () => {
    const [uri] = extractUris(JSON.stringify({ outbounds: [XHTTP] }));
    expect(uri).toContain("vless://11111111-2222-3333-4444-555555555555@192.71.247.209:8443");
    expect(uri).toContain("type=xhttp");
    expect(uri).toContain("security=reality");
    expect(uri).toContain("sni=cdn.example.com");
    expect(uri).toContain("pbk=PUBKEY");
    expect(uri).toContain("sid=ab12");
    expect(uri).toContain("mode=packet-up");
    expect(uri).toContain("path=%2Fassets%2Fv2%2Fstream");
    expect(uri).toContain("#fi");
  });

  it("переносит extra XHTTP в конфиг автовыбора", () => {
    const [uri] = extractUris(JSON.stringify({ outbounds: [XHTTP] }));
    const config = JSON.parse(buildAutoConfig([uri], 5));
    const node = config.outbounds.find((item: { tag: string }) => item.tag === "fi");
    expect(node.streamSettings.xhttpSettings.extra).toEqual({ xPaddingBytes: "20-160" });
    expect(node.streamSettings.xhttpSettings.host).toBe("");
  });

  it("разбирает массив полных конфигов и не дублирует узлы", () => {
    const payload = JSON.stringify([
      { outbounds: [XHTTP, { ...XHTTP, tag: "fi-2" }] },
      { outbounds: [{ tag: "direct", protocol: "freedom" }] },
    ]);
    const uris = extractUris(payload);
    expect(uris).toHaveLength(2);
    expect(nodeFingerprint(uris[0])).toBe(nodeFingerprint(uris[1]));
  });

  it("разбирает Clash YAML и отбрасывает заглушку панели", () => {
    const yaml = `proxies:
  - name: DE
    type: vless
    server: de.example.com
    port: 443
    uuid: 11111111-2222-3333-4444-555555555555
    network: ws
    tls: true
    servername: de.example.com
    ws-opts:
      path: /ws
      headers:
        Host: de.example.com
  - name: App not supported
    type: vless
    server: 0.0.0.0
    port: 1
    uuid: 11111111-2222-3333-4444-555555555555
    network: tcp
`;
    const uris = extractUris(yaml);
    expect(uris).toHaveLength(1);
    expect(uris[0]).toContain("de.example.com:443");
    expect(uris[0]).toContain("type=ws");
    expect(uris[0]).toContain("security=tls");
    expect(uris[0]).toContain("host=de.example.com");
  });

  it("понимает base64-список и пустую заглушку", () => {
    const list = "vless://11111111-2222-3333-4444-555555555555@a.example.com:443?type=tcp&security=none#A";
    expect(extractUris(btoa(list))).toHaveLength(1);
    const stub = btoa("vless://00000000-0000-0000-0000-000000000000@0.0.0.0:1?type=tcp#App%20not%20supported");
    expect(extractUris(stub)).toEqual([]);
  });

  it("при сбое источника сохраняет прошлые узлы", async () => {
    const store = new Map<string, string>();
    const cache = {
      async get(key: string, type?: string) {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
    };
    const env = {
      CACHE: cache,
      MERGE_SOURCE_A: "https://example.invalid/sub",
      MERGE_ENABLED: "0",
      FETCH_UA: "Happ/2.9.1",
    } as unknown as Env;

    store.set(
      "merge:pool:v1",
      JSON.stringify([
        {
          id: "abc",
          link: "vless://11111111-2222-3333-4444-555555555555@old.example.com:443?type=tcp&security=none#Old",
          label: "Old",
          source: "A",
          host: "old.example.com",
          port: 443,
          countryCode: "DE",
          countryName: "Германия",
          city: "",
          status: "alive",
          latencyMs: 120,
          checkedAt: new Date().toISOString(),
          addedAt: new Date().toISOString(),
        },
      ]),
    );

    const status = await syncMerge(env, true);
    expect(status.sources[0].ok).toBe(false);
    const kept = JSON.parse(store.get("merge:pool:v1") ?? "[]") as unknown[];
    expect(kept).toHaveLength(1);
  });

  it("не подмешивает узлы при MERGE_ENABLED=0", async () => {
    const store = new Map<string, string>();
    const cache = {
      async get(key: string, type?: string) {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
    };
    store.set(
      "merge:pool:v1",
      JSON.stringify([
        {
          id: "abc",
          link: "vless://11111111-2222-3333-4444-555555555555@new.example.com:443?type=tcp&security=none#New",
          label: "New",
          source: "A",
          host: "new.example.com",
          port: 443,
          countryCode: "",
          countryName: "",
          city: "",
          status: "unknown",
          latencyMs: null,
          checkedAt: null,
          addedAt: new Date().toISOString(),
        },
      ]),
    );
    const env = { CACHE: cache, MERGE_ENABLED: "0" } as unknown as Env;
    const uris: string[] = [];
    expect(await appendMergedLinks(env, uris)).toBe(0);
    expect(uris).toHaveLength(0);
  });
});
