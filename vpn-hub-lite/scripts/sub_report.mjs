/** Показывает, как выглядит подписка глазами Happ: порядок и подписи. */
// Ссылка подписки содержит личный токен — только из окружения, не из кода.
const url = process.env.SUB_URL;
if (!url) {
  console.error("Задайте SUB_URL — полную ссылку подписки — в окружении.");
  process.exit(1);
}

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
