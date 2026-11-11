/** Сравнивает то, что отдаёт подписка, с исходными конфигами из источника. */
import { readFileSync } from "node:fs";

// Ссылка подписки содержит личный токен. В репозитории её быть не должно:
// передаём через окружение, чтобы скрипт не работал с зашитым секретом.
const subUrl = process.env.SUB_URL;
if (!subUrl) {
  console.error("Задайте SUB_URL — полную ссылку подписки — в окружении.");
  process.exit(1);
}

const response = await fetch(subUrl, { headers: { "user-agent": "Happ/2.7.1 (iPhone; iOS 18.2)" } });
const body = (await response.text()).trim();
const decoded = Buffer.from(body, "base64").toString("utf8");
const served = decoded.split("\n").filter((line) => line.includes("://"));

console.log("строк в подписке:", served.length);
console.log("headers:", JSON.stringify(Object.fromEntries(response.headers)));
console.log("");

const rows = JSON.parse(readFileSync("tmp_all.json", "utf8").replace(/^\uFEFF/, ""))[0].results;
const byHost = new Map();
for (const row of rows) {
  const match = /@([^:/?]+):/.exec(row.link);
  const key = match ? match[1] : row.host;
  byHost.set(key, row.link);
}

console.log("=== сравнение ===");
for (const line of served.slice(0, 4)) {
  const match = /@([^:/?]+):/.exec(line);
  const host = match ? match[1] : "?";
  const original = byHost.get(host);
  console.log(`\n-- host ${host}`);
  console.log("отдаём :", line.slice(0, 260));
  console.log("исходник:", original ? original.slice(0, 260) : "не найден в базе");
  if (original) {
    const q = (u) => [...new URLSearchParams(u.split("?")[1] ?? "").keys()].sort().join(",");
    console.log("параметры отдаём :", q(line));
    console.log("параметры исходник:", q(original));
  }
}
