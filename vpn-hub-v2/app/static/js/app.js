/* VPN Hub: тосты, копирование, добавление, удаление, живой лог. */

function hubToast(text, kind) {
  const box = document.getElementById("toasts");
  if (!box) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function hubCsrf() {
  const node = document.querySelector("[x-data]");
  if (node) {
    const match = node.getAttribute("x-data").match(/csrf:\s*'([^']+)'/);
    if (match) return match[1];
  }
  return "";
}

function hubToggleTheme() {
  const html = document.documentElement;
  const next = html.dataset.theme === "light" ? "dark" : "light";
  html.dataset.theme = next;
  try { localStorage.setItem("hub-theme", next); } catch (e) {}
}
try {
  const saved = localStorage.getItem("hub-theme");
  if (saved) document.documentElement.dataset.theme = saved;
} catch (e) {}

async function hubCopy(id, button) {
  const field = document.getElementById(id);
  if (!field) return;
  try {
    await navigator.clipboard.writeText(field.value);
  } catch (e) {
    field.select();
    document.execCommand("copy");
  }
  const label = button.textContent;
  button.textContent = "Скопировано";
  hubToast("Скопировано");
  setTimeout(() => { button.textContent = label; }, 1500);
}

function hubAdd(event) {
  event.preventDefault();
  const textarea = document.getElementById("add-text");
  const button = document.getElementById("add-btn");
  const text = textarea.value.trim();
  if (!text) { hubToast("Вставьте ссылку или ключ", "warn"); return; }

  button.disabled = true;
  const original = button.innerHTML;
  button.innerHTML = '<span class="spinner"></span> Проверяю';

  fetch("/api/sources/add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: text, csrf: hubCsrf() })
  })
    .then((r) => r.json())
    .then((data) => {
      if (data.error) { hubToast(data.error, "error"); return; }
      const results = data.results || [];
      const alive = results.reduce((sum, item) => sum + (item.alive || 0), 0);
      const root = document.querySelector("[x-data]");
      if (root && window.Alpine) {
        const state = window.Alpine.$data(root);
        state.results = results;
      }
      hubToast(alive ? `Добавлено серверов: ${alive}` : "Ключи добавлены, но не отвечают", alive ? "" : "warn");
      textarea.value = "";
      if (alive) setTimeout(() => window.location.reload(), 1200);
    })
    .catch(() => hubToast("Не удалось отправить. Проверьте связь.", "error"))
    .finally(() => { button.disabled = false; button.innerHTML = original; });
}

/* Фильтр источников в шапке: ничего не грузит, просто скрывает строки. */
function hubFilter(value) {
  const needle = (value || "").trim().toLowerCase();
  document.querySelectorAll("[data-name]").forEach((row) => {
    row.style.display = !needle || row.dataset.name.includes(needle) ? "" : "none";
  });
}

function hubPreview(button) {
  const textarea = document.getElementById("add-text");
  const log = document.getElementById("preview-log");
  const text = textarea.value.trim();
  if (!text) { hubToast("Вставьте ссылку или ключ", "warn"); return; }

  button.disabled = true;
  const label = button.textContent;
  button.textContent = "Смотрю…";
  log.hidden = false;
  log.textContent = "";

  fetch("/api/sources/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: text, csrf: hubCsrf() })
  })
    .then((r) => r.json())
    .then((data) => {
      if (data.error) { hubToast(data.error, "error"); return; }
      const items = data.items || [];
      log.textContent = items.map((item) => {
        if (item.error) return "✕ " + item.line + " — " + item.error;
        const hosts = item.hosts.length ? " (" + item.hosts.join(", ") + ")" : "";
        const kind = item.kind === "public" ? "подписка" : "ключ";
        return "✓ " + kind + ": найдено " + item.found + hosts;
      }).join("\n");
      const total = items.reduce((sum, item) => sum + (item.found || 0), 0);
      hubToast("Найдётся ключей: " + total + ". Ничего не сохранено.");
    })
    .catch(() => hubToast("Не удалось проверить. Проверьте связь.", "error"))
    .finally(() => { button.disabled = false; button.textContent = label; });
}

function hubDelete(id, name) {
  if (!confirm(`Удалить источник «${name}»?`)) return;
  fetch(`/api/sources/${id}/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csrf: hubCsrf() })
  })
    .then((r) => r.json())
    .then((data) => {
      if (data.error) { hubToast(data.error, "error"); return; }
      const row = document.getElementById(`source-${id}`);
      if (row) { row.classList.add("removing"); setTimeout(() => row.remove(), 220); }
      hubToast(`Удалено: ${data.name || name}`);
    })
    .catch(() => hubToast("Не удалось удалить. Проверьте связь.", "error"));
}

function hubRefresh() {
  const button = document.getElementById("refresh-btn");
  const log = document.getElementById("refresh-log");
  if (!button) return;
  log.hidden = false;
  log.textContent = "";
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span> Обновляю';

  fetch("/api/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csrf: hubCsrf() })
  })
    .then((r) => r.json())
    .then((data) => {
      if (!data.run_id) throw new Error("no run");
      const source = new EventSource(`/api/refresh/${data.run_id}/events`);
      source.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        if (payload.type === "log") {
          log.textContent += payload.text + "\n";
          log.scrollTop = log.scrollHeight;
        }
        if (payload.type === "done") {
          source.close();
          button.disabled = false;
          button.textContent = "Обновить всё";
          hubToast("Обновление готово");
          setTimeout(() => window.location.reload(), 900);
        }
      };
      source.onerror = () => {
        source.close();
        button.disabled = false;
        button.textContent = "Обновить всё";
        hubToast("Связь с логом прервалась. Обновите страницу.", "error");
      };
    })
    .catch(() => {
      button.disabled = false;
      button.textContent = "Обновить всё";
      hubToast("Не удалось запустить обновление", "error");
    });
}

function hubProbe(button) {
  button.disabled = true;
  fetch("/api/detector/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csrf: hubCsrf() })
  })
    .then((r) => r.json())
    .then((data) => {
      const text = data.foreign_ok ? "Зарубежные сайты открываются" : "Зарубежные сайты закрыты";
      hubToast(text, data.foreign_ok ? "" : "warn");
    })
    .catch(() => hubToast("Не удалось проверить сеть", "error"))
    .finally(() => { button.disabled = false; });
}

function hubToggleMode(button) {
  const current = button.textContent.includes("Вернуть") ? "whitelist" : "normal";
  const next = current === "whitelist" ? "normal" : "whitelist";
  button.disabled = true;
  fetch("/api/mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: next, csrf: hubCsrf() })
  })
    .then((r) => r.json())
    .then(() => { hubToast("Режим сети переключён"); setTimeout(() => window.location.reload(), 600); })
    .catch(() => hubToast("Не удалось переключить режим", "error"))
    .finally(() => { button.disabled = false; });
}

document.addEventListener("alpine:init", () => {
  window.Alpine.data("hub", (config) => ({
    results: [],
    mode: config.mode,
    hasSources: config.hasSources,
    summary() {
      const alive = this.results.reduce((sum, item) => sum + (item.alive || 0), 0);
      return `живых ключей: ${alive}`;
    },
    itemDetail(item) {
      if (item.error) return item.error;
      const parts = [];
      if (item.host) parts.push(`${item.host}:${item.port}`);
      if (item.latency) parts.push(`${item.latency} мс`);
      if (item.found > 1) parts.push(`ключей: ${item.alive} из ${item.found}`);
      return parts.join(" · ") || "проверено";
    }
  }));
});
