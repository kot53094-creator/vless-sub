/**
 * ИИ-администратор хаба.
 *
 * Задача: чтобы рутина вроде «убери упавшие», «перекинь людей с мёртвых»,
 * «вот ключ — добавь» делалась одной фразой в Telegram, а не командами.
 *
 * Как устроено
 * ------------
 * 1. Детерминированные случаи (ключ в тексте, ссылка на подписку) выполняются
 *    без модели: LLM не должен переписывать UUID и адреса, а ошибка в одном
 *    символе ломает конфиг.
 * 2. Остальное уходит в Workers AI (бесплатные 10 000 нейронов в сутки).
 *    Модель обязана ответить строгим JSON: { action, args, say }.
 * 3. Действие проверяется по белому списку. Всё, что меняет данные,
 *    выполняется только после подтверждения человеком: /ai да.
 *
 * Безопасность: модуль вызывается только для админа (проверка в боте и на
 * HTTP-эндпоинте), секретов в промпт не попадает, ключи не логируются.
 */

import { logEvent, many, one, run } from "./db";
import { addKeys, cmdAddSource, cmdSetStatus } from "./bot/admin";
import { topUpVerified, rebalance } from "./balance";
import { runSync } from "./sync";
import { invalidatePool } from "./sub";
import type { Env } from "./types";

/** Минимальная structural-типизация биндинга Workers AI. */
export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

/** Модели по убыванию качества; первая доступная и используется. */
const MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct",
];

/** Ключ ожидающего подтверждения действия. */
const PENDING = (actor: string) => `ai:pending:${actor}`;

/** Действия, которые меняют данные и требуют «/ai да». */
const MUTATING = new Set([
  "rebalance",
  "replace",
  "sync",
  "mark_dead",
  "add_source",
  "extend_user",
  "ban_user",
  "topup_user",
]);

export type AiAction =
  | "stats"
  | "list_dead"
  | "report"
  | "rebalance"
  | "replace"
  | "sync"
  | "mark_dead"
  | "add_key"
  | "add_source"
  | "extend_user"
  | "ban_user"
  | "topup_user"
  | "answer";

export interface AiPlan {
  action: AiAction;
  args: Record<string, unknown>;
  say: string;
}

const SYSTEM = `Ты — административный ассистент VPN-хаба (Cloudflare Worker, D1, Telegram-бот).
Отвечай ТОЛЬКО компактным JSON без markdown и пояснений вокруг:
{"action":"<действие>","args":{...},"say":"<одна короткая фраза по-русски>"}

Действия и аргументы:
- stats — сводка по серверам, пулу и людям. args: {}
- list_dead — список мёртвых узлов. args: {}
- report — отчёт по нагрузке. args: {}
- rebalance — перераспределить людей с мёртвых узлов. args: {}
- replace — заменить мёртвые узлы живыми у всех активных людей и пересобрать пул. args: {}
- sync — пересобрать источники (долго). args: {}
- mark_dead — пометить узел мёртвым. args: {"host":"адрес или host:port"}
- add_key — добавить ключи. args: {"text":"..."}
- add_source — добавить источник. args: {"name":"...","kind":"public","url":"https://..."}
- extend_user — продлить доступ. args: {"tg_id":"123","days":30}
- ban_user — заблокировать. args: {"tg_id":"123"}
- topup_user — добрать узлы человеку. args: {"tg_id":"123"}
- answer — ответить словами, если данных не хватает. args: {}

Правила:
1. Никогда не выдумывай tg_id, адреса и ссылки. Нет данных — action=answer и попроси их.
2. Тип источника (kind): public, own_vps, trial, bridge_ru, cdn_xhttp, paid_private.
3. Если просят «убрать упавшие» — это mark_dead по конкретному адресу либо rebalance, если адрес не назван.
5. Если просят «заменить сервера» без адреса — это replace, а не rebalance.
4. Ответ строго один объект JSON.`;

/** Сводка состояния для промпта: 1 запрос к D1. */
async function stateBrief(env: Env): Promise<string> {
  const row = await one<{
    servers: number;
    alive: number;
    verified: number;
    dead: number;
    users: number;
    active: number;
    sources: number;
  }>(
    env,
    `SELECT (SELECT COUNT(*) FROM servers) AS servers,
            (SELECT COUNT(*) FROM servers WHERE status='alive') AS alive,
            (SELECT COUNT(*) FROM servers WHERE status='dead') AS dead,
            (SELECT COUNT(*) FROM servers
              WHERE enabled=1 AND status='alive' AND verified_latency_ms>0
                AND verified_at >= datetime('now','-72 hours')) AS verified,
            (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM users WHERE status='active') AS active,
            (SELECT COUNT(*) FROM sources) AS sources`,
  );
  return [
    `узлов всего: ${row?.servers ?? 0}`,
    `живых по порту: ${row?.alive ?? 0}`,
    `проверено туннелем за 72 ч: ${row?.verified ?? 0}`,
    `помечено мёртвыми: ${row?.dead ?? 0}`,
    `источников: ${row?.sources ?? 0}`,
    `людей: ${row?.users ?? 0} (активных ${row?.active ?? 0})`,
  ].join(", ");
}

/** Достаёт первый JSON-объект из ответа модели. */
export function parsePlan(raw: string): AiPlan | null {
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const action = String(obj.action ?? "").trim() as AiAction;
  const known: AiAction[] = [
    "stats",
    "list_dead",
    "report",
    "rebalance",
    "replace",
    "sync",
    "mark_dead",
    "add_key",
    "add_source",
    "extend_user",
    "ban_user",
    "topup_user",
    "answer",
  ];
  if (!known.includes(action)) return null;
  const args =
    obj.args && typeof obj.args === "object" ? (obj.args as Record<string, unknown>) : {};
  return { action, args, say: String(obj.say ?? "").slice(0, 300) };
}

/**
 * Текст ответа из разных форматов Workers AI.
 *
 * Часть моделей отдаёт `{response}`, новые — OpenAI-совместимый формат
 * `{choices:[{message:{content}}]}`. Раньше поддерживался только первый,
 * и рабочий биндинг выглядел как «модель недоступна».
 */
export function textOf(result: unknown): string {
  if (typeof result === "string") return result;
  const r = result as {
    response?: unknown;
    choices?: Array<{ message?: { content?: unknown } }>;
    result?: { response?: unknown };
  } | null;
  const value =
    r?.response ?? r?.choices?.[0]?.message?.content ?? r?.result?.response ?? "";
  if (typeof value === "string") return value;
  // Часть моделей кладёт в `response` уже разобранный объект — тогда
  // возвращаем его обратно в текст, чтобы разбор был единым.
  if (value && typeof value === "object") return JSON.stringify(value);
  return "";
}

/** Ответ модели по тексту запроса. */
async function askModel(env: Env, text: string, brief: string): Promise<AiPlan | null> {
  const ai = env.AI;
  if (!ai) return null;
  for (const model of MODELS) {
    try {
      const result = await ai.run(model, {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Состояние хаба: ${brief}.\nЗапрос админа: ${text}` },
        ],
        max_tokens: 400,
        temperature: 0.1,
      });
      const raw = textOf(result);
      const plan = parsePlan(raw);
      if (plan) return plan;
    } catch (error) {
      console.error("ai model failed", model, error instanceof Error ? error.message : error);
    }
  }
  return null;
}

/**
 * Диагностика биндинга: есть ли AI у воркера и что отвечает модель.
 * Нужна, когда /ai пишет «модель недоступна», — иначе причину не видно:
 * ошибки биндинга не попадают в ответ клиенту.
 */
export async function aiDiagnose(env: Env): Promise<Record<string, unknown>> {
  if (!env.AI) return { hasAI: false, reason: "биндинг AI не подключён" };
  try {
    // Прогоняем настоящий системный промпт: видно и сырой ответ, и разбор.
    const result = await env.AI.run(MODELS[0], {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: "Состояние хаба: тест.\nЗапрос админа: что с серверами?" },
      ],
      max_tokens: 200,
      temperature: 0.1,
    });
    const raw = textOf(result);
    return {
      hasAI: true,
      model: MODELS[0],
      ok: true,
      raw: raw.slice(0, 400),
      parsed: parsePlan(raw),
      // Форма ответа целиком: у моделей она разная, и без неё не видно,
      // куда именно попал текст.
      shape: JSON.stringify(result).slice(0, 900),
    };
  } catch (error) {
    return {
      hasAI: true,
      model: MODELS[0],
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Человеческий текст действия — его видит админ до подтверждения. */
function describe(plan: AiPlan): string {
  const a = plan.args;
  switch (plan.action) {
    case "mark_dead":
      return `Пометить мёртвым: ${String(a.host ?? "—")}`;
    case "add_source":
      return `Добавить источник «${String(a.name ?? "—")}» (${String(a.kind ?? "public")}): ${String(a.url ?? "—")}`;
    case "extend_user":
      return `Продлить ${String(a.tg_id ?? "—")} на ${Number(a.days ?? 0)} дн.`;
    case "ban_user":
      return `Заблокировать ${String(a.tg_id ?? "—")}`;
    case "topup_user":
      return `Добрать узлы пользователю ${String(a.tg_id ?? "—")}`;
    case "rebalance":
      return "Перераспределить людей с мёртвых узлов";
    case "replace":
      return "Заменить мёртвые узлы живыми у всех активных людей";
    case "sync":
      return "Пересобрать все источники";
    default:
      return plan.say || plan.action;
  }
}

/** Выполнение действия. Возвращает текст ответа админу. */
async function execute(env: Env, plan: AiPlan): Promise<string> {
  switch (plan.action) {
    case "stats": {
      const brief = await stateBrief(env);
      return `Сводка: ${brief}.`;
    }
    case "list_dead": {
      const rows = await many<{ host: string; port: number; last_check_at: string | null }>(
        env,
        `SELECT host, port, last_check_at FROM servers
          WHERE status='dead' ORDER BY last_check_at DESC LIMIT 10`,
      );
      if (!rows.length) return "Мёртвых узлов нет.";
      return `Мёртвые (${rows.length}):\n` +
        rows.map((r) => `• ${r.host}:${r.port}`).join("\n");
    }
    case "report": {
      const brief = await stateBrief(env);
      return `Отчёт: ${brief}.`;
    }
    case "rebalance": {
      const moved = await rebalance(env);
      await logEvent(env, "ai", null, `rebalance: ${moved}`);
      return `Перераспределено назначений: ${moved}.`;
    }
    case "replace": {
      // Массовая замена: у каждого активного человека список должен снова
      // содержать 15 заведомо рабочих узлов. Ограничение в 50 человек — это
      // лимит подзапросов D1 на один вызов воркера; при большей базе действие
      // нужно вызывать частями.
      const users = await many<{ id: number }>(
        env,
        "SELECT id FROM users WHERE status = 'active' ORDER BY id LIMIT 50",
      );
      let added = 0;
      let touched = 0;
      for (const user of users) {
        try {
          const count = await topUpVerified(env, user.id, 15);
          if (count > 0) {
            added += count;
            touched++;
          }
        } catch {
          // Один сбойный человек не должен отменять замену остальным.
        }
      }
      await invalidatePool(env);
      await logEvent(env, "ai", null, `replace: +${added} узлов у ${touched}`);
      return `Замена: добрано ${added} узлов у ${touched} из ${users.length} человек. Пул пересобран.`;
    }
    case "sync": {
      const result = await runSync(env);
      await logEvent(env, "ai", null, "sync по команде ИИ");
      return `Источники пересобраны: ${JSON.stringify(result).slice(0, 400)}`;
    }
    case "mark_dead": {
      const target = String(plan.args.host ?? "").trim();
      if (!target) return "Не указан адрес узла.";
      const [name = target, portRaw] = target.split(":");
      const port = Number(portRaw);
      const byPort = Number.isFinite(port) && port > 0;
      const rows = byPort
        ? await many<{ id: number }>(
            env,
            "SELECT id FROM servers WHERE host = ? AND port = ?",
            name,
            port,
          )
        : await many<{ id: number }>(env, "SELECT id FROM servers WHERE host = ?", target);
      if (!rows.length) return `Узел ${target} не найден.`;
      for (const row of rows) {
        // Отдельный UPDATE, а не cmdSetStatus: та функция ищет человека по
        // tg_id, а здесь речь о сервере.
        await run(
          env,
          "UPDATE servers SET status='dead', last_check_at=datetime('now') WHERE id = ?",
          row.id,
        );
      }
      await invalidatePool(env);
      await logEvent(env, "ai", null, `mark_dead: ${target} (${rows.length})`);
      return `Помечено мёртвым: ${target} (${rows.length}).`;
    }
    case "add_key": {
      const text = String(plan.args.text ?? "");
      if (!text) return "Нет ключа в запросе.";
      return await addKeys(env, text);
    }
    case "add_source": {
      return await cmdAddSource(
        env,
        String(plan.args.name ?? "ai-source").slice(0, 60),
        String(plan.args.kind ?? "public"),
        String(plan.args.url ?? ""),
      );
    }
    case "extend_user": {
      const tg = String(plan.args.tg_id ?? "").replace(/\D/g, "");
      const days = Number(plan.args.days ?? 0);
      if (!tg || !days) return "Нужны tg_id и число дней.";
      return await cmdSetStatus(env, tg, "extend", String(days));
    }
    case "ban_user": {
      const tg = String(plan.args.tg_id ?? "").replace(/\D/g, "");
      if (!tg) return "Нужен tg_id.";
      return await cmdSetStatus(env, tg, "status", "banned");
    }
    case "topup_user": {
      const tg = String(plan.args.tg_id ?? "").replace(/\D/g, "");
      if (!tg) return "Нужен tg_id.";
      const user = await one<{ id: number }>(env, "SELECT id FROM users WHERE tg_id = ?", tg);
      if (!user) return "Такого пользователя нет.";
      const added = await topUpVerified(env, user.id, 15);
      return `Добавлено узлов: ${added}.`;
    }
    default:
      return plan.say || "Не понял запрос — сформулируйте иначе.";
  }
}

/** Ключи и ссылки распознаём без модели: LLM легко портит UUID. */
export function detectDirect(text: string):
  | { kind: "key"; payload: string }
  | { kind: "source"; payload: string }
  | null {
  const keyLines = text
    .split(/\s+/)
    .filter((t) => /^(vless|vmess|trojan|ss|hysteria2):\/\//i.test(t));
  if (keyLines.length) return { kind: "key", payload: keyLines.join("\n") };
  const url = text.match(/https?:\/\/\S+/)?.[0];
  if (url && /(добав|источник|подписк|ключ)/i.test(text)) {
    return { kind: "source", payload: url };
  }
  return null;
}

/**
 * Главная точка входа. actor — tg_id админа или "api".
 * Возвращает текст для отправки в чат.
 */
export async function handleAiCommand(
  env: Env,
  actor: string,
  text: string,
): Promise<string> {
  const query = text.trim();
  if (!query) return "Напишите задачу: /ai что с серверами";

  // Подтверждение отложенного действия.
  if (/^(да|yes|ок|ok|подтверждаю)$/i.test(query)) {
    const raw = await env.CACHE.get(PENDING(actor));
    if (!raw) return "Нечего подтверждать.";
    await env.CACHE.delete(PENDING(actor));
    const plan = JSON.parse(raw) as AiPlan;
    return await execute(env, plan);
  }
  if (/^(нет|no|отмена|cancel)$/i.test(query)) {
    await env.CACHE.delete(PENDING(actor));
    return "Отменено.";
  }

  const direct = detectDirect(query);
  if (direct?.kind === "key") {
    return await addKeys(env, direct.payload);
  }
  if (direct?.kind === "source") {
    return await cmdAddSource(env, "ai-source", "public", direct.payload);
  }

  const brief = await stateBrief(env);
  const plan = await askModel(env, query, brief);
  if (!plan) {
    return "Модель недоступна. Пока работают команды: /servers, /rebalance, /report, /addkey.";
  }

  if (MUTATING.has(plan.action)) {
    await env.CACHE.put(PENDING(actor), JSON.stringify(plan), { expirationTtl: 600 });
    return `Предлагаю: ${describe(plan)}.\nОтправьте «/ai да» для выполнения или «/ai нет» для отмены.`;
  }

  return await execute(env, plan);
}
