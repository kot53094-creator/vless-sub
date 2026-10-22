async function serversPage(env: Env, url: URL): Promise<Response> {
  const csrf = await csrfToken(env);
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");

  const q = (url.searchParams.get("q") ?? "").trim();
  const st = url.searchParams.get("st") ?? "";
  const tier = url.searchParams.get("tier") ?? "";
  const country = url.searchParams.get("country") ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const per = 40;

  const where: string[] = [];
  const params: unknown[] = [];
  if (q) {
    where.push("(s.host LIKE ? OR s.remark LIKE ? OR s.country_name LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (st === "on") where.push("s.enabled = 1 AND s.status = 'alive'");
  if (st === "off") where.push("s.enabled = 0");
  if (st === "dead") where.push("s.enabled = 1 AND s.status = 'dead'");
  if (st === "unknown") where.push("s.enabled = 1 AND s.status = 'unknown'");
  if (tier) {
    where.push("s.tier = ?");
    params.push(tier);
  }
  if (country) {
    where.push("s.country_code = ?");
    params.push(country);
  }

  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [rows, totals, countries] = await Promise.all([
    many<{
      id: number;
      host: string;
      port: number;
      remark: string;
      status: string;
      enabled: number;
      tier: string;
      country_name: string | null;
      city: string | null;
      country_code: string | null;
      latency_ms: number | null;
      last_check_at: string | null;
      users: number;
    }>(
      env,
      `SELECT s.id, s.host, s.port, s.remark, s.status, s.enabled, s.tier,
              s.country_name, s.city, s.country_code, s.latency_ms, s.last_check_at,
              (SELECT COUNT(*) FROM assignments a WHERE a.server_id = s.id) AS users
         FROM servers s ${filter}
        ORDER BY s.enabled DESC, (s.status = 'alive') DESC,
                 (s.latency_ms IS NULL), s.latency_ms, s.id
        LIMIT ? OFFSET ?`,
      ...params,
      per,
      (page - 1) * per,
    ),
    one<{ total: number }>(env, `SELECT COUNT(*) AS total FROM servers s ${filter}`, ...params),
    many<{ country_code: string; country_name: string; n: number }>(
      env,
      `SELECT country_code, country_name, COUNT(*) AS n FROM servers
        WHERE country_code IS NOT NULL AND country_code <> ''
        GROUP BY country_code ORDER BY n DESC LIMIT 40`,
    ),
  ]);

  const total = totals?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / per));

  const statusPill = (server: { enabled: number; status: string }) => {
    if (!server.enabled) return `<span class="pill">выключен</span>`;
    if (server.status === "alive") return `<span class="pill ok">ONLINE</span>`;
    if (server.status === "dead") return `<span class="pill bad">OFFLINE</span>`;
    return `<span class="pill warn">UNKNOWN</span>`;
  };

  const when = (value: string | null) => {
    if (!value) return "—";
    const ts = Date.parse(`${value.replace(" ", "T")}Z`);
    if (!Number.isFinite(ts)) return "—";
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return "только что";
    if (mins < 60) return `${mins} мин назад`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} ч назад`;
    return `${Math.round(hours / 24)} дн назад`;
  };

  const body_rows = rows
    .map((server) => {
      const name = server.country_name
        ? `VLESS · ${server.country_name}${server.city && server.city.length <= 16 ? ` · ${server.city}` : ""}`
        : "VLESS · Регион неизвестен";
      return `<tr data-row="${esc(server.host)}">
        <td><input type="checkbox" name="ids" value="${server.id}" form="bulk"></td>
        <td>${esc(name)}
          <div class="muted mono" style="font-size:11px">${esc(server.host)}:${server.port} · #${server.id}</div></td>
        <td>${statusPill(server)}</td>
        <td>${server.latency_ms ?? "—"} мс</td>
        <td><span class="pill">${esc(server.tier)}</span></td>
        <td>${server.users}</td>
        <td class="muted">${when(server.last_check_at)}</td>
        <td style="white-space:nowrap">
          <form method="post" action="/admin/action" class="inline">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="server_toggle">
            <input type="hidden" name="id" value="${server.id}">
            <button class="btn">${server.enabled ? "Выключить" : "Включить"}</button>
          </form>
          <form method="post" action="/admin/action" class="inline">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="check_ids">
            <input type="hidden" name="ids" value="${server.id}">
            <button class="btn">Проверить</button>
          </form>
          <form method="post" action="/admin/action" class="inline"
                onsubmit="return confirm('Удалить сервер ${esc(server.host)}? Он пропадёт у ${server.users} пользователей.')">
            <input type="hidden" name="csrf" value="${csrf}">
            <input type="hidden" name="action" value="server_delete">
            <input type="hidden" name="id" value="${server.id}">
            <button class="btn danger">×</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  const countryOptions = countries
    .map(
      (item) =>
        `<option value="${esc(item.country_code)}"${country === item.country_code ? " selected" : ""}>${esc(item.country_name || item.country_code)} (${item.n})</option>`,
    )
    .join("");

  const body = `
<h1>Серверы</h1>
<div class="sub">Статус, задержка, доступ и тарифная категория</div>
${ok ? `<div class="notice">${esc(ok)}</div>` : ""}
${err ? `<div class="err">${esc(err)}</div>` : ""}

<div class="card">
  <div class="head">
    <h2>${total} серверов</h2><div class="spacer"></div>
    <form method="post" action="/admin/action" class="inline">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="action" value="health">
      <button class="btn">Проверить пачку</button>
    </form>
    <form method="post" action="/admin/action" class="inline">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="action" value="refill">
      <button class="btn">Добрать всем</button>
    </form>
    <form method="post" action="/admin/action" class="inline">
      <input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="action" value="geo">
      <button class="btn">Определить страны</button>
    </form>
  </div>

  <form method="get" action="/admin/servers" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
    <input name="q" value="${esc(q)}" placeholder="поиск по адресу или метке" style="flex:1;min-width:180px">
    <select name="st">
      <option value="">любой статус</option>
      <option value="on"${st === "on" ? " selected" : ""}>ONLINE</option>
      <option value="dead"${st === "dead" ? " selected" : ""}>OFFLINE</option>
      <option value="unknown"${st === "unknown" ? " selected" : ""}>UNKNOWN</option>
      <option value="off"${st === "off" ? " selected" : ""}>выключенные</option>
    </select>
    <select name="tier">
      <option value="">любой тариф</option>
      <option value="free"${tier === "free" ? " selected" : ""}>FREE</option>
      <option value="premium"${tier === "premium" ? " selected" : ""}>PREMIUM</option>
      <option value="personal"${tier === "personal" ? " selected" : ""}>PERSONAL</option>
    </select>
    <select name="country"><option value="">все страны</option>${countryOptions}</select>
    <button class="btn primary">Показать</button>
  </form>

  <form id="bulk" method="post" action="/admin/action" style="margin-bottom:10px">
    <input type="hidden" name="csrf" value="${csrf}">
    <input type="hidden" name="action" value="bulk_servers">
    <select name="op">
      <option value="check">проверить выбранные</option>
      <option value="disable">выключить</option>
      <option value="enable">включить</option>
      <option value="free">тариф FREE</option>
      <option value="premium">тариф PREMIUM</option>
      <option value="delete">удалить</option>
    </select>
    <button class="btn">Применить к выбранным</button>
    <span class="muted">максимум 10 за раз</span>
  </form>

  <table>
    <thead><tr><th></th><th>Сервер</th><th>Статус</th><th>Задержка</th><th>Тариф</th><th>Людей</th><th>Проверен</th><th></th></tr></thead>
    <tbody>${body_rows || `<tr><td colspan="8" class="muted">Ничего не найдено</td></tr>`}</tbody>
  </table>

  <p class="muted" style="margin-top:10px">
    Проверка сейчас — TCP-коннект: «ONLINE» значит «порт отвечает», а не «туннель работает».
    Реальная проверка VLESS требует отдельного агента с Xray и сервера вне Cloudflare.
  </p>

  <div style="display:flex;gap:8px;margin-top:10px">
    ${page > 1 ? `<a class="btn" href="/admin/servers?page=${page - 1}&q=${encodeURIComponent(q)}&st=${st}&tier=${tier}&country=${country}">← Назад</a>` : ""}
    <span class="muted" style="align-self:center">страница ${page} из ${pages}</span>
    ${page < pages ? `<a class="btn" href="/admin/servers?page=${page + 1}&q=${encodeURIComponent(q)}&st=${st}&tier=${tier}&country=${country}">Вперёд →</a>` : ""}
  </div>
</div>`;
  return page("Серверы", body, "servers", env);
}
