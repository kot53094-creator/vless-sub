import pathlib
import re

p = pathlib.Path("src/bot/admin.ts")
s = p.read_text(encoding="utf-8")

old = """  const waiting = await many<{ id: number }>(
    env,
    `SELECT u.id FROM users u
     WHERE u.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.user_id = u.id)
     LIMIT 20`,
  );
  for (const person of waiting) {
    await assignForUser(env, person.id, Number(env.SERVERS_PER_USER ?? "3"));
  }"""

new = """  // Доводим выдачу до нормы у всех: иначе новые ключи не попадают в подписку.
  const delivered = await topUpAllActive(env);"""

if old not in s:
    raise SystemExit("waiting block not found")

s = s.replace(old, new)
s = s.replace(
    'return `Добавлено ключей: ${keys.length} (источник #${sourceId}).`;',
    'return `Добавлено ключей: ${keys.length} (источник #${sourceId}), роздано серверам: ${delivered}.`;',
)

if 'from "../delivery"' not in s:
    s = s.replace(
        'import { assignForUser, assignmentCount } from "../balance";',
        'import { assignmentCount } from "../balance";\nimport { topUpAllActive } from "../delivery";',
    )

p.write_text(s, encoding="utf-8")
print("ok")
