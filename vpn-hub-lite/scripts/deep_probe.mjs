/**
 * Р¤СѓРЅРєС†РёРѕРЅР°Р»СЊРЅР°СЏ РїСЂРѕРІРµСЂРєР° РЅРѕРґ: TCP + TLS + HTTP Рє WS-РїСѓС‚Рё СЃ РЅСѓР¶РЅС‹Рј SNI.
 * РџРёС€РµС‚ alive_ids.txt Рё dead_ids.txt (id С‡РµСЂРµР· Р·Р°РїСЏС‚СѓСЋ).
 * Р—Р°РїСѓСЃРє: node scripts/deep_probe.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import tls from "node:tls";

const rows = JSON.parse(readFileSync("tmp_all.json", "utf8").replace(/^\uFEFF/, ""))[0].results;
const CONCURRENCY = 40;
const TIMEOUT_MS = 7000;

function params(link) {
  const sni = /sni=([^&]+)/.exec(link)?.[1] ?? "";
  const rawPath = /(?:\?|&)path=([^&]+)/.exec(link)?.[1] ?? "%2F";
  return { sni, path: decodeURIComponent(rawPath) };
}

function probe(row) {
  return new Promise((resolve) => {
    const { sni, path } = params(row.link);
    const servername = sni || row.host;
    let done = false;

    const finish = (code) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        /* СѓР¶Рµ Р·Р°РєСЂС‹С‚ */
      }
      resolve({ id: row.id, code });
    };

    const socket = tls.connect(
      {
        host: row.host,
        port: Number(row.port),
        servername,
        rejectUnauthorized: false,
        timeout: TIMEOUT_MS,
      },
      () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: ${servername}\r\nUser-Agent: Happ/2.9.1\r\nConnection: close\r\n\r\n`,
        );
      },
    );

    socket.setTimeout(TIMEOUT_MS, () => finish("000"));

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(buffer);
      if (match) finish(match[1]);
      if (buffer.length > 4096) finish("000");
    });
    socket.on("error", () => finish("000"));
    socket.on("close", () => finish("000"));
  });
}

async function main() {
  const alive = [];
  const dead = [];
  let index = 0;

  async function worker() {
    while (index < rows.length) {
      const row = rows[index++];
      const result = await probe(row);
      if (["400", "404", "426", "200", "101"].includes(result.code)) alive.push(result.id);
      else dead.push(result.id);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  writeFileSync("alive_ids.txt", alive.join(","), "utf8");
  writeFileSync("dead_ids.txt", dead.join(","), "utf8");
  console.log(`СЂР°Р±РѕС‡РёС…: ${alive.length}, РјС‘СЂС‚РІС‹С…: ${dead.length}, РІСЃРµРіРѕ: ${rows.length}`);
}

main();

