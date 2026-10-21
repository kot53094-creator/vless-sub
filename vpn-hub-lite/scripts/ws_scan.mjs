/** Параллельная проверка WebSocket-upgrade по всем серверам из tmp_all.json. */
import { readFileSync, writeFileSync } from "node:fs";
import tls from "node:tls";

const rows = JSON.parse(readFileSync("tmp_all.json", "utf8").replace(/^\uFEFF/, ""))[0].results;
const CONCURRENCY = 30;

function parts(link) {
  const sni = /sni=([^&]+)/.exec(link)?.[1] ?? "";
  const host = /[?&]host=([^&]+)/.exec(link)?.[1] ?? sni;
  const rawPath = /(?:\?|&)path=([^&]+)/.exec(link)?.[1] ?? "%2F";
  return { sni, host, path: decodeURIComponent(rawPath) };
}

function probe(row) {
  return new Promise((resolve) => {
    const { sni, host, path } = parts(row.link);
    const servername = sni || row.host;
    let done = false;

    const finish = (status) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
      resolve({ id: row.id, status });
    };

    const socket = tls.connect(
      {
        host: row.host,
        port: Number(row.port),
        servername,
        rejectUnauthorized: false,
        timeout: 6000,
      },
      () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\n` +
            `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${Buffer.from(String(Math.random())).toString("base64")}\r\n` +
            `Sec-WebSocket-Version: 13\r\n\r\n`,
        );
      },
    );

    socket.setTimeout(6000, () => finish("000"));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(buffer);
      if (match) finish(match[1]);
    });
    socket.on("error", () => finish("000"));
    socket.on("close", () => finish("000"));
  });
}

const good = [];
const bad = [];
let index = 0;

async function worker() {
  while (index < rows.length) {
    const row = rows[index++];
    const result = await probe(row);
    if (result.status === "101") good.push(result.id);
    else bad.push(result.id);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

writeFileSync("ws_ok.txt", good.join(","), "utf8");
writeFileSync("ws_bad.txt", bad.join(","), "utf8");
console.log(`WS поднимается: ${good.length}, не поднимается: ${bad.length}, всего: ${rows.length}`);
