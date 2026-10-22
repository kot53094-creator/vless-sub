
/* ══════════════════════════════════════════════════════════════════════════
   Карточка сервера: имя, страна, тариф, приоритет, история проверок
   ══════════════════════════════════════════════════════════════════════════ */

async function serverEditPage(env: Env, url: URL): Promise<Response> {
  const csrf = await csrfToken(env);
  const id = Number(url.searchParams.get("id") ?? 0);
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");

  const server = await one<{
    id: number;
    host: string;
    port: number;
    remark: string;
    status: string;
    enabled: number;
    tier: string;
    priority: number;
    country_code: string | null;
    country_name: string | null;
    city: string | null;
    latency_ms: number | null;
    last_check_at: string | null;
    link: string;
  }>(env, "SELECT * FROM servers WHERE id = ?", id);

  if (!server) {
    return page("Сервер не найден", `<div class="card"><p>Сервер #${id} не существует.</p>
      <a class="btn" href="/admin/servers">← К списку</a></div>`, "servers", env);
  }

  const checks = await many<{ checked_at: string; result: string; latency_ms: number | null; error: string | null }>(
    env,
    "SELECT checked_at, result, latency_ms, error FROM server_checks WHERE server_id = ? ORDER BY id DESC LIMIT 12",
    id,
  );
  const users = await one<{ n: number }>(
    env,
    "SELECT COUNT(*) AS n FROM assignments WHERE server_id = ?",
    id,
  );

  const checkRows = checks
    .map(
      (check) =>
        `<tr><td class="muted">${esc(check.checked_at)}</td>
         <td>${check.result === "ok" ? `<span class="pill ok">ok</span>` : `<span class="pill bad">fail</span>`}</td>
         <td>${check.latency_ms ?? "—"} мс</td>
         <td class="muted">${esc(check.error ?? "")}</td></tr>`,
    )
    .join("");

  const body = `
<h1>Сервер #${server.id}</h1>
<div class="sub mono">${esc(server.host)}:${server.port} · выдано людям: ${users?.n ?? 0}</div>
${ok ? `<div class="notice">${esc(ok)}</div>` : ""}
${err ? `<div class="err">${esc(err)}</div>` : ""}

<div class="card">
  <div class="head"><h2>Настройки</h2></div>
  <form method="post" action="/admin/action" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="action" value="server_save">
    <input type="hidden" name="id" value="${server.id}">
    <div style="flex:1;min-width:220px">
      <label class="muted">Название для пользователя</label><br>
      <input name="remark" value="${esc(server.remark)}" style="width:100%">
    </div>
    <div><label class="muted">Код страны</label><br>
      <input name="country_code" value="${esc(server.country_code ?? "")}" maxlength="2" style="width:70px"></div>
    <div><label class="muted">Страна</label><br>
      <input name="country_name" value="${esc(server.country_name ?? "")}" style="width:150px"></div>
    <div><label class="muted">Тариф</label><br>
      <select name="tier">
        ${["free", "premium", "personal"].map((t) => `<option value="${t}"${server.tier === t ? " selected" : ""}>${t.toUpperCase()}</option>`).join("")}
      </select></div>
    <div><label class="muted">Приоритет</label><br>
      <input name="priority" value="${server.priority}" inputmode="numeric" style="width:90px"></div>
    <div><label class="muted">Состояние</label><br>
      <select name="enabled">
        <option value="1"${server.enabled ? " selected" : ""}>включён</option>
        <option value="0"${server.enabled ? "" : " selected"}>выключен</option>
      </select></div>
    <button class="btn primary">Сохранить</button>
  </form>
  <p class="muted" style="margin:10px 0 0">
    Название показывается в подписке как есть, если заполнено. Пусто — имя соберётся
    из протокола и страны. Приоритет выше нуля поднимает сервер в начало списка.
  </p>
</div>

<div class="card">
  <div class="head"><h2>История проверок</h2></div>
  <table>
    <thead><tr><th>Когда</th><th>Результат</th><th>Задержка</th><th>Ошибка</th></tr></thead>
    <tbody>${checkRows || `<tr><td colspan="4" class="muted">Проверок ещё не было</td></tr>`}</tbody>
  </table>
  <p class="muted" style="margin-top:10px">Проверка — TCP-коннект к порту. Туннель VLESS не проверяется.</p>
</div>

<a class="btn" href="/admin/servers">← К списку серверов</a>`;

  return page(`Сервер #${server.id}`, body, "servers", env);
}
