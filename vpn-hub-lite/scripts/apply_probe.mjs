/** Применяет результаты deep_probe к D1: статусы + чистка мёртвых связей. */
import { readFileSync, writeFileSync } from "node:fs";

const alive = readFileSync("alive_ids.txt", "utf8").trim();
const dead = readFileSync("dead_ids.txt", "utf8").trim();

const lines = [];
if (alive) {
  lines.push(
    `UPDATE servers SET status='alive', last_check_at=datetime('now') WHERE id IN (${alive});`,
  );
}
if (dead) {
  lines.push(
    `UPDATE servers SET status='dead', last_check_at=datetime('now') WHERE id IN (${dead});`,
  );
  // мёртвые не должны занимать слоты у людей
  lines.push(`DELETE FROM assignments WHERE server_id IN (${dead});`);
  lines.push(`DELETE FROM pool_servers WHERE server_id IN (${dead});`);
}

// статистика по источникам: сколько живых осталось
lines.push(`SELECT s.id, s.name, SUM(CASE WHEN sv.status='alive' THEN 1 ELSE 0 END) AS alive,
                   COUNT(sv.id) AS total
              FROM sources s LEFT JOIN servers sv ON sv.source_id = s.id
             GROUP BY s.id ORDER BY alive DESC;`);

writeFileSync("apply_probe.sql", lines.join("\n"), "utf8");
console.log("apply_probe.sql готов:", lines.length, "операторов");
