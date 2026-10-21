import pathlib
import re

p = pathlib.Path("src/bot/user.ts")
s = p.read_text(encoding="utf-8")

start = s.index("function ago(hourStamp: string): string {")
end = s.index("/** Подтверждение: перевыпуск ссылки выкидывает все устройства сразу. */")
new_block = '''function ago(value: string): string {
  const stamp = value.length <= 13 ? `${value}:00:00` : value;
  const ts = Date.parse(`${stamp.replace(" ", "T")}Z`);
  if (!Number.isFinite(ts)) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  return `${days} ${plural(days, "день", "дня", "дней")} назад`;
}

/** Экран «Устройства»: имена клиентов и отвязка по одному. */
export async function sendDevicesInfo(
  env: Env,
  chatId: number | string,
  user: UserRow,
  messageId?: number,
): Promise<void> {
  const devices = await listDevices(env, user.id);
  const active = devices.filter((item) => !item.blocked);
  const blocked = devices.filter((item) => item.blocked);

  const lines = [
    `<b>Устройства</b>`,
    `Лимит: ${user.device_limit} · подключено: ${active.length}`,
    "",
  ];

  if (active.length) {
    active.forEach((item, index) => {
      lines.push(`${index + 1}. ${escapeHtml(item.label)} — ${ago(item.last_seen)}`);
    });
  } else {
    lines.push("Пока ни одно устройство не открывало подписку.");
  }

  if (blocked.length) {
    lines.push("", "<b>Отключены</b>");
    blocked.forEach((item) => lines.push(`• ${escapeHtml(item.label)}`));
  }

  lines.push(
    "",
    "Отвязать можно одно устройство — остальные продолжат работать.",
  );

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const item of active.slice(0, 5)) {
    rows.push([{ text: `✖️ Отвязать ${item.label}`, callback_data: `dvb:${item.id}` }]);
  }
  for (const item of blocked.slice(0, 3)) {
    rows.push([{ text: `↩️ Вернуть ${item.label}`, callback_data: `dvu:${item.id}` }]);
  }
  rows.push([{ text: "🔄 Отключить все", callback_data: "dev:kick" }]);
  rows.push([
    { text: "👤 Кабинет", callback_data: "act:cabinet" },
    { text: "← В меню", callback_data: "act:menu" },
  ]);

  await screen(env, chatId, messageId, "account", lines.join("\\n"), { inline_keyboard: rows });
}

'''

s = s[:start] + new_block + s[end:]

# импорт новых функций из sub
s = s.replace(
    'import { devices24h, invalidateSubscription, rotateToken } from "../sub";',
    'import {\n  devices24h,\n  invalidateSubscription,\n  listDevices,\n  rotateToken,\n  setDeviceBlocked,\n} from "../sub";',
)

p.write_text(s, encoding="utf-8")
print("patched", len(s))
