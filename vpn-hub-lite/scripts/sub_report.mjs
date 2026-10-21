/** Показывает, как выглядит подписка глазами Happ: порядок и подписи. */
const url =
  "https://vpn-hub-lite.twistx-launcher.workers.dev/sub/Ej0mbpxIY6-iN8yIvg6g813QXp6N2NqOZzlnSYI_ifE";

const response = await fetch(url, { headers: { "user-agent": "Happ/2.7.1 (iPhone; iOS 18.2)" } });
const body = (await response.text()).trim();
const lines = Buffer.from(body, "base64").toString("utf8").split("\n").filter((l) => l.includes("://"));

console.log(`нод: ${lines.length}\n`);
lines.slice(0, 12).forEach((line, i) => {
  const label = decodeURIComponent(line.split("#")[1] ?? "");
  console.log(`${String(i + 1).padStart(2)}. ${label}`);
});

console.log("\n--- распределение по группам ---");
const groups = new Map();
for (const line of lines) {
  const label = decodeURIComponent(line.split("#")[1] ?? "");
  const key = label.split("·")[0].trim();
  groups.set(key, (groups.get(key) ?? 0) + 1);
}
console.log([...groups.entries()].map(([k, v]) => `${k}: ${v}`).join("\n"));

const ds = lines
  .map((line, i) => ({ i: i + 1, label: decodeURIComponent(line.split("#")[1] ?? "") }))
  .filter((item) => /Апельсинка|VLESSio/.test(item.label));
console.log("\n--- Апельсинка ---");
console.log(ds.length ? ds.map((d) => `${d.i}. ${d.label}`).join("\n") : "не найдено");
