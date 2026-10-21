/** Проверка WebSocket-upgrade: 101 значит эндпоинт реально живой. */
import { readFileSync } from "node:fs";
import tls from "node:tls";

const rows = JSON.parse(readFileSync("tmp_all.json", "utf8").replace(/^\uFEFF/, ""))[0].results;

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
    const key = Buffer.from(Math.random().toString(36).slice(2, 18)).toString("base64");
    let done = false;

    const finish = (status) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {}
      resolve(status);
    };

    const socket = tls.connect(
      {
        host: row.host,
        port: Number(row.port),
        servername,
        rejectUnauthorized: false,
        timeout: 8000,
      },
      () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\n` +
            `Host: ${host}\r\n` +
            `User-Agent: Mozilla/5.0\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\n` +
            `Sec-WebSocket-Version: 13\r\n\r\n`,
        );
      },
    );

    socket.setTimeout(8000, () => finish("000"));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(buffer);
      if (match) finish(match[1]);
      if (buffer.length > 2048) finish("000");
    });
    socket.on("error", () => finish("000"));
    socket.on("close", () => finish("000"));
  });
}

let ok = 0;
const lines = [];
for (const row of rows) {
  const status = await probe(row);
  if (status === "101") ok++;
  lines.push(`${status === "101" ? "WS-OK " : "no-ws "} ${row.host}:${row.port} -> ${status}`);
}
console.log(lines.join("\n"));
console.log(`\nWebSocket поднялся: ${ok} из ${rows.length}`);
