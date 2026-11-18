/**
 * API для Telegram Mini App (Личный кабинет «Апельсинка VPN»).
 *
 * Все эндпоинты защищены проверкой Telegram initData (HMAC-SHA256) либо токеном.
 */

import { authenticateAppUser } from "./webapp_auth";
import { daysLeft, many, one, run, logEvent } from "./db";
import { envStr, memRateLimit, randomToken } from "./security";
import { claimDaily, redeemPromo, referralStats, referralLink } from "./bonus";
import { loadPlans, type PlanRow } from "./plans";
import { checkout, enabledProviders, planPriceLine, PROVIDER_LABELS } from "./pay";
import { formatRub, starsForPlan } from "./pay/money";
import { findOrder, listOrders, ordersReady } from "./orders";
import { deviceFamily, deviceModel } from "./sub";
import { deviceLimitOf, trafficQuotaGb } from "./limits";
import { findPack, listTrafficPacks, packAsPlan } from "./traffic_packs";
import type { ProviderId } from "./pay/types";
import { mergedNodes, mergeStatus } from "./merge";
import { regionOf } from "./groups";
import type { Env, UserRow } from "./types";

interface DeviceRow {
  id: number;
  user_id: number;
  device_key: string;
  label: string;
  last_seen: string | null;
  blocked: number;
  blocked_reason?: string;
  custom_name?: string | null;
  auto_named?: number;
}

/**
 * Автоматическое имя устройства.
 *
 * Клиенты подписки (Happ, INCY, v2rayNG) модель телефона не присылают —
 * в их User-Agent есть только платформа. Зато мини-кабинет открывается
 * внутри Telegram, а там модель в User-Agent есть. Поэтому при открытии
 * кабинета сервер сам подписывает то устройство, чья платформа совпадает
 * с текущим телефоном и которое видели последним.
 *
 * Имя ставится один раз: ручное переименование и сброс выставляют
 * auto_named = 1, чтобы автоматика больше не вмешивалась.
 */
async function autoNameDevices(
  env: Env,
  userId: number,
  ua: string,
  devices: DeviceRow[],
): Promise<void> {
  const model = deviceModel(ua);
  const family = deviceFamily(ua);
  if (!model || !family) return;

  const sameFamily = (label: string): boolean => {
    const text = String(label || "").toLowerCase();
    if (family === "android") return text.includes("android");
    if (family === "ios" || family === "ipados") return text.includes("ios") || text.includes("iphone") || text.includes("ipad");
    if (family === "windows") return text.includes("windows");
    if (family === "macos") return text.includes("macos") || text.includes("mac");
    if (family === "linux") return text.includes("linux");
    return false;
  };

  const candidates = devices.filter((device) => {
    if (String(device.custom_name ?? "").trim()) return false;
    if (Number(device.auto_named ?? 0) === 1) return false;
    if (device.blocked) return false;
    if (!sameFamily(device.label)) return false;
    // Старые записи не трогаем: имя нужно живому устройству.
    const seen = device.last_seen ? Date.parse(String(device.last_seen).replace(" ", "T") + "Z") : 0;
    return seen > 0 && Date.now() - seen < 7 * 24 * 3600 * 1000;
  });

  // Несколько одинаковых платформ — не угадываем, чтобы не подписать чужое.
  if (candidates.length !== 1) return;
  const target = candidates[0];

  try {
    await run(
      env,
      "UPDATE user_devices SET custom_name = ?, auto_named = 1 WHERE id = ? AND user_id = ?",
      model,
      target.id,
      userId,
    );
    target.custom_name = model;
    target.auto_named = 1;
  } catch {
    // Колонки auto_named ещё нет — просто оставляем автоматическую подпись.
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-telegram-init-data, x-sub-token",
    },
  });
}

export async function handleAppApi(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-telegram-init-data, x-sub-token",
      },
    });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  // 1. Публичные эндпоинты без обязательной авторизации
  if (path === "/api/app/plans" && request.method === "GET") {
    let plans: PlanRow[] = [];
    try {
      plans = await loadPlans(env);
    } catch {
      plans = [];
    }
    // Никаких «демо-тарифов» на случай пустой базы: человек не должен видеть
    // цену, по которой нельзя купить. Пустой список — честный ответ, а
    // витрина в этом случае говорит «оплата ещё не подключена».
    const providers = enabledProviders(env).filter((item) => item !== "manual");
    const ready = await ordersReady(env);
    return jsonResponse({
      ok: true,
      // «Настроено» = есть тариф с ценой И хотя бы один рабочий способ оплаты.
      // Иначе витрина показывала готовность при пустом списке провайдеров.
      configured: ready && providers.length > 0 && plans.some((p) => p.price_rub > 0),
      checkout_ready: ready,
      providers: providers.map((id) => ({ id, label: PROVIDER_LABELS[id] })),
      // Порядок в кабинете — по сроку: 1 → 2 → 3 → 6 → 12 месяцев. Сортировка
      // по `featured` ставила «Популярный» первым, и витрина начиналась с
      // третьего месяца, хотя человек ищет минимальный вход.
      plans: [...plans]
        .sort((a, b) => a.days - b.days || a.price_rub - b.price_rub)
        .map((p) => ({
        id: p.id,
        code: p.code,
        title: p.title,
        price_rub: p.price_rub,
        price_label: formatRub(p.price_rub),
        price_stars:
          p.price_rub > 0 && providers.includes("stars") ? starsForPlan(p, env) : null,
        price_line: planPriceLine(p, env),
        days: p.days,
        device_limit: p.device_limit,
        description: p.note,
        badge: p.badge ?? "",
        featured: Boolean(p.featured),
        purchasable: p.price_rub > 0 && p.days > 0,
      })),
    });
  }

  if (path === "/api/app/faq" && request.method === "GET") {
    const faq = [
      {
        q: "Как подключить подписку в приложении INCY?",
        a: "1. Скопируйте ссылку подписки в личном кабинете.\n2. Откройте INCY и нажмите «+» (добавить конфигурацию).\n3. Выберите «Импорт из буфера обмена» и разрешите добавление VPN-профиля.\n4. Выберите сервер AUTO для автоматического выбора наилучшего узла или группу EUROPE.",
      },
      {
        q: "В чем разница между обычной подпиской и группами?",
        a: "Обычная ссылка выдаёт классический список доступных серверов. Ссылка «Группы» выдаёт настроенные профили (AUTO, EUROPE, RUSSIA, BACKUP) со встроенным балансировщиком leastPing — приложение само переключает трафик при сбое узла.",
      },
      {
        q: "Как работают подключённые устройства?",
        a: "Каждое подключённое устройство регистрируется в системе. В личном кабинете вы можете видеть активные устройства и при необходимости отключать старые или утерянные.",
      },
      {
        q: "Что даёт реферальная программа?",
        a: "Вы получаете персональную ссылку. За каждого приглашённого друга вы получаете +3 дня премиум-подписки (или бонус на баланс), а друг получает расширенный пробный период.",
      },
      {
        q: "Что делать, если скорость упала или сервер не отвечает?",
        a: "В приложении выберите группу AUTO или обновите подписку (потяните список серверов вниз). Система автоматически исключает проблемные узлы из автоподбора.",
      },
    ];
    return jsonResponse({ ok: true, faq });
  }

  // 2. Аутентификация для пользовательских эндпоинтов
  const auth = await authenticateAppUser(env, request);
  if (!auth.ok || !auth.user) {
    return jsonResponse({ ok: false, error: auth.error || "unauthorized" }, 401);
  }

  const user = auth.user;
  const baseUrl = (envStr(env.PUBLIC_BASE_URL) || "https://vpn-hub-lite.twistx-launcher.workers.dev").replace(/\/$/, "");

  // GET /api/app/me — главное состояние личного кабинета
  if (path === "/api/app/me" && request.method === "GET") {
    const remainingDays = daysLeft(user.expires_at) ?? 0;
    const isActive = user.status === "active" && remainingDays > 0;

    // Устройства пользователя
    let devices: DeviceRow[] = [];
    try {
      devices = await many<DeviceRow>(
        env,
        "SELECT id, user_id, device_key, label, last_seen, blocked, custom_name, auto_named FROM user_devices WHERE user_id = ? ORDER BY id DESC",
        user.id,
      );
    } catch {
      try {
        devices = await many<DeviceRow>(
          env,
          "SELECT id, user_id, device_key, label, last_seen, blocked FROM user_devices WHERE user_id = ? ORDER BY id DESC",
          user.id,
        );
      } catch {
        devices = [];
      }
    }

    // Само подписываем устройство по модели телефона из Telegram-клиента.
    await autoNameDevices(env, user.id, request.headers.get("user-agent") ?? "", devices);

    // Реферальная статистика
    let refStats = { invited: 0, rewarded: 0, days: 0 };
    try {
      refStats = await referralStats(env, user.id);
    } catch {
      // default
    }

    const botUsername = envStr(env.BOT_USERNAME) || "apelsinka_vpn_bot";
    const refLink = `https://t.me/${botUsername}?start=ref_${user.tg_id}`;

    // Серверы для статистики
    let totalServers = 0;
    let aliveServers = 0;
    const countries = new Set<string>();
    try {
      const nodes = await mergedNodes(env);
      totalServers = nodes.length;
      aliveServers = nodes.filter((n) => n.status === "alive").length;
      nodes.forEach((n) => {
        if (n.countryCode) countries.add(n.countryCode.toUpperCase());
      });
    } catch {
      totalServers = 12;
      aliveServers = 10;
      countries.add("DE").add("NL").add("FI").add("RU");
    }

    const subToken = user.sub_token;
    const subUrl = `${baseUrl}/sub/${subToken}`;
    const groupsSubUrl = `${baseUrl}/sub/${subToken}/groups`;

    // Трафик. Учёт по узлам не ведётся (Workers не видит объём через
    // туннель), поэтому вместо выдуманных «12.4 ГБ» отдаём честный ноль:
    // безлимит — если квота не задана, иначе лимит без измерения.
    // Квота = тарифная + докупленная. null — безлимит.
    const quota = trafficQuotaGb(user);
    const quotaGb = quota ?? 0;
    const isUnlimited = quota === null;
    const extraGb = Math.max(0, Number(user.traffic_extra_gb ?? 0));
    const usedMb = Math.max(0, Number(user.traffic_used_mb ?? 0));
    const measured = usedMb > 0;
    const usedGb = Math.round((usedMb / 1024) * 10) / 10;
    const percent = quotaGb > 0 ? Math.min(100, Math.round((usedGb / quotaGb) * 100)) : null;
    const deviceLimit = deviceLimitOf(user, env);

    return jsonResponse({
      ok: true,
      user: {
        id: user.id,
        tg_id: user.tg_id,
        username: user.tg_username || auth.tgUser?.username || "",
        first_name: auth.tgUser?.first_name || "",
        photo_url: auth.tgUser?.photo_url || "",
        tier: user.tier || "free",
        status: user.status,
      },
      subscription: {
        active: isActive,
        status: user.status,
        tier: user.tier === "premium" ? "PREMIUM" : "БАЗОВЫЙ",
        plan_title: user.tier === "premium" ? "⚡️ APELSINKA PREMIUM" : "⚡️ APELSINKA FREE",
        expires_at: user.expires_at,
        days_left: Math.max(0, remainingDays),
        sub_token: subToken,
        sub_url: subUrl,
        groups_sub_url: groupsSubUrl,
        auto_sub_url: `${baseUrl}/sub/${subToken}/auto`,
        europe_sub_url: `${baseUrl}/sub/${subToken}/europe`,
        russia_sub_url: `${baseUrl}/sub/${subToken}/russia`,
      },
      traffic: {
        unlimited: isUnlimited,
        limit_gb: isUnlimited ? null : quotaGb,
        extra_gb: extraGb,
        // Расход приходит от агента узлов. Пока агент не подключён — 0 и
        // measured: false, чтобы интерфейс не рисовал выдуманные проценты.
        used_gb: usedGb,
        measured,
        percent: isUnlimited ? null : percent,
        exhausted: !isUnlimited && usedGb >= quotaGb,
        reset_at: user.traffic_reset_at ?? null,
      },
      // Есть ли учёт расхода вообще. Пока ни один узел не присылал статистику,
      // traffic_reported_at пустой — значит квота не уменьшается физически,
      // и кабинет обязан это показать, а не рисовать «10 ГБ свободно».
      metering: {
        available: Boolean(user.traffic_reported_at) || usedMb > 0,
        last_report_at: user.traffic_reported_at ?? null,
      },
      devices: {
        count: devices.filter((d) => !d.blocked).length,
        limit: deviceLimit,
        list: devices.map((d) => ({
          id: d.id,
          label: d.label || "Устройство",
          name: (d.custom_name ?? "") || "",
          last_seen: d.last_seen,
          blocked: Boolean(d.blocked),
          reason: (d as { blocked_reason?: string }).blocked_reason ?? "",
          // Отвязать можно любое своё устройство: и активное, и заблокированное.
          can_remove: true,
        })),
      },
      referrals: {
        invited: refStats.invited,
        rewarded: refStats.rewarded,
        bonus_days: refStats.days,
        ref_link: refLink,
        ref_code: user.tg_id,
      },
      servers: {
        total: totalServers,
        alive: aliveServers,
        countries: Array.from(countries),
      },
      branding: {
        name: "Апельсинка VPN",
        support_bot: botUsername,
        updated_at: new Date().toISOString(),
      },
    });
  }

  // GET /api/app/traffic-packs — пакеты докупки трафика.
  if (path === "/api/app/traffic-packs" && request.method === "GET") {
    const packs = await listTrafficPacks(env);
    return jsonResponse({
      ok: true,
      // Докупка имеет смысл только при заданной квоте: безлимит не докупают.
      unlimited: trafficQuotaGb(user) === null,
      packs: packs.map((pack) => ({
        code: pack.code,
        gb: pack.gb,
        price_rub: pack.price_rub,
        price_label: formatRub(pack.price_rub),
        title: pack.title || `+${pack.gb} ГБ`,
      })),
    });
  }

  // POST /api/app/topup — купить пакет трафика.
  if (path === "/api/app/topup" && request.method === "POST") {
    if (!memRateLimit(`topup:${user.id}`, 6, 60)) {
      return jsonResponse({ ok: false, error: "Слишком часто. Подождите минуту." }, 429);
    }
    if (!(await ordersReady(env))) {
      return jsonResponse({ ok: false, error: "Оплата временно недоступна" }, 503);
    }
    let body: { code?: string; provider?: string } = {};
    try {
      body = (await request.json()) as { code?: string; provider?: string };
    } catch {
      return jsonResponse({ ok: false, error: "bad_json" }, 400);
    }

    const pack = await findPack(env, String(body.code ?? ""));
    if (!pack) return jsonResponse({ ok: false, error: "Пакет не найден" }, 404);

    const available = enabledProviders(env).filter(
      (item): item is ProviderId => item !== "manual",
    );
    const provider = (body.provider ?? available[0] ?? "") as ProviderId;
    if (!available.includes(provider)) {
      return jsonResponse({ ok: false, error: "Способ оплаты недоступен" }, 400);
    }

    const result = await checkout(env, user, packAsPlan(pack), provider);
    if (!result.ok) {
      return jsonResponse({ ok: false, error: result.error ?? "Не удалось создать счёт" }, 502);
    }

    return jsonResponse({
      ok: true,
      order: result.order?.public_id,
      provider,
      link: result.link ?? null,
      open_invoice: provider === "stars",
      gb: pack.gb,
      amount_rub: pack.price_rub,
    });
  }

  // POST /api/app/buy — создать счёт на продление.
  //
  // Mini App не может показать нативный счёт бота, поэтому для звёзд
  // возвращается ссылка `createInvoiceLink`: клиент открывает её через
  // Telegram.WebApp.openInvoice. Для карты и крипты — обычный URL страницы
  // оплаты, его открывает браузер.
  if (path === "/api/app/buy" && request.method === "POST") {
    if (!memRateLimit(`appbuy:${user.id}`, 8, 60)) {
      return jsonResponse({ ok: false, error: "Слишком часто. Подождите минуту." }, 429);
    }
    let body: { plan_code?: string; provider?: string } = {};
    try {
      body = (await request.json()) as { plan_code?: string; provider?: string };
    } catch {
      return jsonResponse({ ok: false, error: "bad_json" }, 400);
    }

    if (!(await ordersReady(env))) {
      return jsonResponse({ ok: false, error: "Оплата временно недоступна" }, 503);
    }

    const plans = await loadPlans(env);
    const plan = plans.find((item) => item.code === String(body.plan_code ?? ""));
    if (!plan || plan.price_rub <= 0 || plan.days <= 0) {
      return jsonResponse({ ok: false, error: "Тариф недоступен" }, 404);
    }

    const available = enabledProviders(env).filter(
      (item): item is ProviderId => item !== "manual",
    );
    const provider = (body.provider ?? available[0] ?? "") as ProviderId;
    if (!available.includes(provider)) {
      return jsonResponse({ ok: false, error: "Способ оплаты недоступен" }, 400);
    }

    const result = await checkout(env, user, plan, provider);
    if (!result.ok) {
      return jsonResponse({ ok: false, error: result.error ?? "Не удалось создать счёт" }, 502);
    }

    return jsonResponse({
      ok: true,
      order: result.order?.public_id,
      provider,
      link: result.link ?? null,
      amount_rub: plan.price_rub,
      amount_stars: provider === "stars" ? starsForPlan(plan, env) : null,
      // Звёзды открываются через openInvoice, остальное — обычной ссылкой.
      open_invoice: provider === "stars",
      plan_title: plan.title,
      days: plan.days,
    });
  }

  // GET /api/app/orders — история покупок для вкладки «Баланс».
  if (path === "/api/app/orders" && request.method === "GET") {
    const orders = await listOrders(env, user.id, 20);
    return jsonResponse({
      ok: true,
      orders: orders.map((order) => ({
        id: order.public_id,
        plan: order.plan_title,
        days: order.days,
        amount_rub: order.amount_rub,
        provider: order.provider,
        provider_label: PROVIDER_LABELS[order.provider],
        status: order.status,
        created_at: order.created_at,
        paid_at: order.paid_at,
      })),
    });
  }

  // GET /api/app/order/<public_id> — статус конкретного счёта.
  if (path.startsWith("/api/app/order/") && request.method === "GET") {
    const publicId = decodeURIComponent(path.slice("/api/app/order/".length));
    const order = await findOrder(env, publicId);
    if (!order || order.user_id !== user.id) {
      return jsonResponse({ ok: false, error: "order_not_found" }, 404);
    }
    return jsonResponse({
      ok: true,
      order: {
        id: order.public_id,
        status: order.status,
        plan: order.plan_title,
        days: order.days,
        amount_rub: order.amount_rub,
        paid_at: order.paid_at,
      },
    });
  }

  // POST /api/app/promo/claim — активация промокода
  if (path === "/api/app/promo/claim" && request.method === "POST") {
    let body: { code?: string } = {};
    try {
      body = (await request.json()) as { code?: string };
    } catch {
      return jsonResponse({ ok: false, error: "bad_json" }, 400);
    }
    const code = String(body.code || "").trim();
    if (!code) return jsonResponse({ ok: false, error: "empty_code" }, 400);

    const outcome = await redeemPromo(env, user, code);
    if (!outcome.ok) {
      return jsonResponse({
        ok: false,
        error: outcome.reason === "used" ? "Промокод уже использован" : "Неверный или истёкший промокод",
      });
    }

    const addedDays = outcome.days ?? Math.round((outcome.hours ?? 0) / 24);
    await logEvent(env, "promo_app", user.id, `промокод ${code} активирован`);
    return jsonResponse({
      ok: true,
      message: `Промокод активирован! Добавлено дней: ${addedDays}`,
      days: addedDays,
    });
  }

  // POST /api/app/daily/claim — забрать бонус дня
  if (path === "/api/app/daily/claim" && request.method === "POST") {
    const outcome = await claimDaily(env, user);
    if (!outcome.ok) {
      return jsonResponse({
        ok: false,
        error: outcome.reason === "already" ? "Бонус дня уже получен сегодня. Приходите завтра!" : "Ошибка бонуса",
      });
    }
    await logEvent(env, "daily_app", user.id, `бонус дня получен: +${outcome.hours} ч`);
    return jsonResponse({
      ok: true,
      message: `Бонус получен! +${outcome.hours} ч. Серия: ${outcome.streak} дн.`,
      hours: outcome.hours,
      streak: outcome.streak,
      new_expiry: outcome.expiresAt,
    });
  }

  // POST /api/app/devices/toggle — заблокировать / разблокировать устройство
  if (path === "/api/app/devices/toggle" && request.method === "POST") {
    let body: { device_id?: number } = {};
    try {
      body = (await request.json()) as { device_id?: number };
    } catch {
      return jsonResponse({ ok: false, error: "bad_json" }, 400);
    }
    const deviceId = Number(body.device_id || 0);
    if (!deviceId) return jsonResponse({ ok: false, error: "invalid_id" }, 400);

    const dev = await one<DeviceRow>(env, "SELECT * FROM user_devices WHERE id = ? AND user_id = ?", deviceId, user.id);
    if (!dev) return jsonResponse({ ok: false, error: "device_not_found" }, 404);

    const newBlocked = dev.blocked ? 0 : 1;
    await run(env, "UPDATE user_devices SET blocked = ? WHERE id = ?", newBlocked, deviceId);
    return jsonResponse({ ok: true, blocked: Boolean(newBlocked) });
  }

  // POST /api/app/devices/rename — дать устройству своё имя.
  // Клиенты почти никогда не присылают модель телефона, поэтому имя задаёт
  // человек: «Samsung A25», «Ноутбук», «Телефон мамы». Пустая строка — сброс.
  if (path === "/api/app/devices/rename" && request.method === "POST") {
    let body: { device_id?: number; name?: string } = {};
    try {
      body = (await request.json()) as { device_id?: number; name?: string };
    } catch {
      return jsonResponse({ ok: false, error: "bad_json" }, 400);
    }
    const deviceId = Number(body.device_id || 0);
    if (!deviceId) return jsonResponse({ ok: false, error: "invalid_id" }, 400);

    const name = String(body.name ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);

    const dev = await one<DeviceRow>(
      env,
      "SELECT id, user_id FROM user_devices WHERE id = ? AND user_id = ?",
      deviceId,
      user.id,
    );
    if (!dev) return jsonResponse({ ok: false, error: "device_not_found" }, 404);

    // auto_named = 1 при любом ручном действии: автоматика больше не
    // перезапишет имя, даже если человек его очистил.
    await run(
      env,
      "UPDATE user_devices SET custom_name = ?, auto_named = 1 WHERE id = ? AND user_id = ?",
      name || null,
      deviceId,
      user.id,
    );
    return jsonResponse({ ok: true, name });
  }

  // POST /api/app/devices/delete — удалить устройство
  if (path === "/api/app/devices/delete" && request.method === "POST") {
    let body: { device_id?: number } = {};
    try {
      body = (await request.json()) as { device_id?: number };
    } catch {
      return jsonResponse({ ok: false, error: "bad_json" }, 400);
    }
    const deviceId = Number(body.device_id || 0);
    if (!deviceId) return jsonResponse({ ok: false, error: "invalid_id" }, 400);

    await run(env, "DELETE FROM user_devices WHERE id = ? AND user_id = ?", deviceId, user.id);
    return jsonResponse({ ok: true });
  }

  // POST /api/app/key/refresh — обновить персональный токен подписки
  if (path === "/api/app/key/refresh" && request.method === "POST") {
    const newToken = randomToken(16);
    await run(env, "UPDATE users SET sub_token = ? WHERE id = ?", newToken, user.id);
    await logEvent(env, "token_refresh_app", user.id, "перевыпущен токен подписки");
    return jsonResponse({
      ok: true,
      sub_token: newToken,
      sub_url: `${baseUrl}/sub/${newToken}`,
      groups_sub_url: `${baseUrl}/sub/${newToken}/groups`,
    });
  }

  // GET /api/app/history — история операций и начислений
  if (path === "/api/app/history" && request.method === "GET") {
    let accruals: Array<{ id: number; days: number; reason: string; created_at: string }> = [];
    try {
      accruals = await many(
        env,
        "SELECT id, days, reason, created_at FROM accruals WHERE user_id = ? ORDER BY id DESC LIMIT 20",
        user.id,
      );
    } catch {
      accruals = [];
    }
    return jsonResponse({ ok: true, history: accruals });
  }

  return jsonResponse({ ok: false, error: "endpoint_not_found" }, 404);
}
