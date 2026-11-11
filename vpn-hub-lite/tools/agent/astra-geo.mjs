/**
 * Достаёт страны из профиля Astra и печатает SQL для проставления гео.
 *
 * Зачем отдельный скрипт: конвертер ссылок берёт тег outbound («proxy-3»),
 * а страна лежит в remarks профиля. Поэтому имя узла терялось, и на выходе
 * получались безликие «Премиум сервер #7» без флага.
 *
 * Запуск: node tools/agent/astra-geo.mjs .tmp/astra2.raw > .tmp/astra-geo.sql
 */

import { readFileSync } from "node:fs";

const COUNTRY = [
  ["эстони", "EE", "Эстония"],
  ["финлянди", "FI", "Финляндия"],
  ["латви", "LV", "Латвия"],
  ["литв", "LT", "Литва"],
  ["франци", "FR", "Франция"],
  ["германи", "DE", "Германия"],
  ["нидерланд", "NL", "Нидерланды"],
  ["сша", "US", "США"],
  ["великобритани", "GB", "Великобритания"],
  ["польш", "PL", "Польша"],
  ["канад", "CA", "Канада"],
  ["япони", "JP", "Япония"],
  ["турци", "TR", "Турция"],
  ["швеци", "SE", "Швеция"],
  ["швейцари", "CH", "Швейцария"],
  ["испани", "ES", "Испания"],
  ["итали", "IT", "Италия"],
  ["австри", "AT", "Австрия"],
  ["чехи", "CZ", "Чехия"],
  ["румыни", "RO", "Румыния"],
  ["болгари", "BG", "Болгария"],
  ["армени", "AM", "Армения"],
  ["казахстан", "KZ", "Казахстан"],
  ["кипр", "CY", "Кипр"],
  ["гонконг", "HK", "Гонконг"],
  ["сингапур", "SG", "Сингапур"],
  ["инди", "IN", "Индия"],
  ["бразили", "BR", "Бразилия"],
  ["австрали", "AU", "Австралия"],
];

const file = process.argv[2];
if (!file) {
  console.error("нужен: config.json");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(file, "utf8"));
const profiles = Array.isArray(raw) ? raw : [raw];
const seen = new Set();
const out = [];

for (const profile of profiles) {
  const remark = String(profile.remarks ?? "");
  const low = remark.toLowerCase();
  const hit = COUNTRY.find(([needle]) => low.includes(needle));
  if (!hit) continue;

  for (const ob of profile.outbounds ?? []) {
    const vnext = ob?.settings?.vnext;
    if (!Array.isArray(vnext)) continue;
    for (const node of vnext) {
      const key = `${node.address}:${node.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ host: node.address, port: node.port, code: hit[1], name: hit[2], remark });
    }
  }
}

for (const row of out) {
  console.log(
    `UPDATE servers SET country_code='${row.code}', country_name='${row.name}' ` +
      `WHERE source_id=(SELECT id FROM sources WHERE name='Премиум') ` +
      `AND host='${row.host}' AND port=${row.port};`,
  );
}

console.error(`стран найдено: ${out.length} из ${profiles.length} профилей`);
