
/* ══════════════════════════════════════════════════════════════════════════
   Подписки: тариф, срок, устройства, продление и отзыв доступа
   ══════════════════════════════════════════════════════════════════════════ */

async function subsPage(env: Env, url: URL): Promise<Response> {
  const csrf = await csrfToken(env);
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");

  const users = await many<{
    id: number;
    tg_id: string;
    status: string;
    tier: string;
    expires_at: string | null;
    traffic_gb: number;
    device_limit: number;
    servers: number;
    devices: number;
  }>(
    env,
    `SELECT u.id, u.tg_id, u.status, u.tier, u.expires_at, u.traffic_gb, u.device_limit,
            (SELECT COUNT(*) FROM assignments a WHERE a.user_id = u.id) AS servers,
            (SELECT COUNT(*) FROM user_devices d WHERE d.user_id = u.id AND d.blocked = 0) AS devices
       FROM users u ORDER BY u.id`,
  );

  const rows = users
    .map((user) => {
      const until = user.expires_at?.slice(0, 10) ?? "—";
      const pill =
        user.status === "active"
          ? `<span class="pill ok">активна</span>`
          : user.status === "pending"
            ? `<span class="pill warn">заявка</span>`
            : `<span class="pill bad">${esc(user.status)}</span>`;
      return `<tr data-row="${esc(user.tg_id)}">
        <td class="mono">${esc(user.tg_id)}</td>
        <td>${pill}</td>
        <td><span class="pill">${esc(user.tier)}</span></td>
        <td>${until}</td>
        <td>${user.servers}</td>
        <td>${user.devices} / ${user.device_limit}</td>
        <td style="white-space:nowrap">
          <form method="post" action="/admin/action" class="inline">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="sub_extend">
            <input type="hidden" name="id" value="${user.id}">
            <input type="hidden" name="days" value="7">
            <button class="btn">+7 дн</button>
          </form>
          <form method="post" action="/admin/action" class="inline">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="sub_extend">
            <input type="hidden" name="id" value="${user.id}">
            <input type="hidden" name="days" value="30">
            <button class="btn">+30 дн</button>
          </form>
          <form method="post" action="/admin/action" class="inline">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="sub_tier">
            <input type="hidden" name="id" value="${user.id}">
            <select name="tier" onchange="this.form.submit()">
              ${["free", "premium"].map((t) => `<option value="${t}"${user.tier === t ? " selected" : ""}>${t.toUpperCase()}</option>`).join("")}
            </select>
          </form>
          <form method="post" action="/admin/action" class="inline"
                onsubmit="return confirm('Отозвать доступ у ${esc(user.tg_id)}?')">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="sub_revoke">
            <input type="hidden" name="id" value="${user.id}">
            <button class="btn danger">Отозвать</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  const active = users.filter((user) => user.status === "active").length;
  const premium = users.filter((user) => user.tier === "premium").length;

  const body = `
<h1>Подписки</h1>
<div class="sub">${users.length} аккаунтов · активных ${active} · премиум ${premium}</div>
${ok ? `<div class="notice">${esc(ok)}</div>` : ""}
${err ? `<div class="err">${esc(err)}</div>` : ""}

<div class="card">
  <div class="head">
    <h2>Все аккаунты</h2><div class="spacer"></div>
    <form method="post" action="/admin/action" class="inline">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="action" value="maintenance">
      <button class="btn">Закрыть просроченные</button>
    </form>
    <a class="btn primary" href="/admin/grant">Выдать подписку</a>
  </div>
  <table>
    <thead><tr><th>Telegram ID</th><th>Статус</th><th>Тариф</th><th>До</th><th>Серверов</th><th>Устройства</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="muted">Пользователей нет</td></tr>`}</tbody>
  </table>
  <p class="muted" style="margin-top:10px">
    «Просроченные» закрываются автоматически каждые 20 минут. Кнопка выше делает это сразу.
  </p>
</div>`;

  return page("Подписки", body, "subs", env);
}
