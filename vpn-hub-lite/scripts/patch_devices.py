import pathlib

p = pathlib.Path("src/bot/user.ts")
s = p.read_text(encoding="utf-8")

old = '''export async function sendDevicesInfo(
  env: Env,
  chatId: number | string,
  user: UserRow,
  messageId?: number,
): Promise<void> {
  const used = await devices24h(env, user.id);
  const lines = [
    `<b>Устройства</b>`,
    `Лимит: ${user.device_limit}`,
    `Подключалось за 24 ч: ${used}`,
    "",
    used >= user.device_limit
      ? "Лимит выбран. Отключите лишнее устройство или попросите добавить слот."
      : `Свободно: ${user.device_limit - used}`,
  ];
  await screen(env, chatId, messageId, "account", lines.join("\\n"), cabinetKeyboard({ referral: true }));
}'''

new = '''function ago(hourStamp: string): string {
  const ts = Date.parse(`${hourStamp}:00:00Z`);
  if (!Number.isFinite(ts)) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  return `${days} ${plural(days, "день", "дня", "дней")} назад`;
}

/** Экран «Устройства»: список активных подключений и кнопка отключения. */
export async function sendDevicesInfo(
  env: Env,
  chatId: number | string,
  user: UserRow,
  messageId?: number,
): Promise<void> {
  const used = await devices24h(env, user.id);
  const rows = await many<{ ip_hash: string; ua_hash: string; last: string }>(
    env,
    `SELECT ip_hash, ua_hash, MAX(ts_hour) AS last
       FROM fetch_log
      WHERE user_id = ? AND ts_hour >= strftime('%Y-%m-%dT%H', datetime('now', '-3 days'))
      GROUP BY ip_hash, ua_hash
      ORDER BY last DESC LIMIT 5`,
    user.id,
  );

  const lines = [
    `<b>Устройства</b>`,
    `Лимит: ${user.device_limit} · за 24 ч: ${used}`,
    "",
  ];

  if (rows.length) {
    rows.forEach((row, index) => {
      lines.push(`${index + 1}. было в сети ${ago(row.last)}`);
    });
    lines.push(
      "",
      "Если устройство потеряно, продано или просто больше не нужно — отключите все:",
      "ссылка перевыпустится, и старое подключение перестанет работать.",
    );
  } else {
    lines.push(
      "Активных подключений не видно.",
      "",
      "Как только добавите ссылку в Happ, устройство появится здесь.",
    );
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: "🔄 Отключить все устройства", callback_data: "dev:kick" }],
      [
        { text: "👤 Кабинет", callback_data: "act:cabinet" },
        { text: "← В меню", callback_data: "act:menu" },
      ],
    ],
  };

  await screen(env, chatId, messageId, "account", lines.join("\\n"), keyboard);
}

/** Подтверждение: перевыпуск ссылки выкидывает все устройства сразу. */
export async function confirmKickDevices(
  env: Env,
  chatId: number | string,
  user: UserRow,
  messageId?: number,
): Promise<void> {
  const used = await devices24h(env, user.id);
  const text = [
    "<b>Отключить все устройства?</b>",
    "",
    `Сейчас в сети: ${used}.`,
    "Ссылка перевыпустится, старая перестанет работать на всех устройствах —",
    "включая это. Понадобится добавить новую в Happ.",
    "",
    "Это действие нельзя отменить.",
  ].join("\\n");

  await screen(env, chatId, messageId, "account", text, {
    inline_keyboard: [
      [{ text: "✅ Да, отключить", callback_data: "dev:kick_yes" }],
      [{ text: "Отмена", callback_data: "act:devs" }],
    ],
  });
}

/**
 * Само отключение: новый токен подписки + очистка истории устройств.
 * Старые клиенты ходят по старому токену и получают 404.
 */
export async function kickDevices(
  env: Env,
  chatId: number | string,
  user: UserRow,
  messageId?: number,
): Promise<void> {
  const token = await rotateToken(env, user);
  await run(env, "DELETE FROM fetch_log WHERE user_id = ?", user.id);
  await logEvent(env, "devices_kick", user.id, "все устройства отключены");

  const text = [
    "<b>Готово, устройства отключены</b>",
    "",
    "Старая ссылка больше не работает. Добавьте новую на нужном устройстве:",
    `<code>${escapeHtml(linkFor(env, token))}</code>`,
  ].join("\\n");

  await screen(env, chatId, messageId, "account", text, cabinetKeyboard({ referral: true, active: true }));
}'''

if old not in s:
    raise SystemExit("pattern not found")

p.write_text(s.replace(old, new), encoding="utf-8")
print("ok")
