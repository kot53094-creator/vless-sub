/**
 * Тихие часы: ночью не проверяем узлы, не тянем источники и не шлём
 * уведомления. Нужно, чтобы квота D1/KV и лимиты источников не сгорали,
 * пока сервисом никто не пользуется.
 *
 * Что НЕ отключается: бэкап базы и приём сообщений бота. Бэкап — это
 * сохранность данных, а бот должен отвечать в любое время.
 *
 * Часовой пояс задаётся смещением в часах, а не именем зоны: в Worker нет
 * базы IANA-зон, а фиксированное смещение для Иркутска не меняется.
 */

export interface QuietWindow {
  /** Час начала тишины по местному времени, 0–23. */
  startHour: number;
  /** Час окончания (не включая), 0–23. */
  endHour: number;
  /** Смещение местного времени от UTC в часах. */
  utcOffset: number;
}

const DEFAULT_HOURS = "23-8";
const DEFAULT_OFFSET = "8";

function parseHour(raw: string): number | null {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0 || value > 23) return null;
  return value;
}

/**
 * Разобрать `QUIET_HOURS` («23-8») и `QUIET_UTC_OFFSET` («8»).
 * Пустая строка или `off` полностью отключает тишину.
 */
export function parseQuiet(hoursRaw?: string, offsetRaw?: string): QuietWindow | null {
  const hours = (hoursRaw ?? DEFAULT_HOURS).trim().toLowerCase();
  if (hours === "" || hours === "off" || hours === "0") return null;

  const match = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(hours);
  if (!match) return null;
  const startHour = parseHour(match[1] ?? "");
  const endHour = parseHour(match[2] ?? "");
  if (startHour === null || endHour === null || startHour === endHour) return null;

  const offset = Number((offsetRaw ?? DEFAULT_OFFSET).trim());
  const utcOffset = Number.isFinite(offset) && Math.abs(offset) <= 14 ? offset : 8;

  return { startHour, endHour, utcOffset };
}

/** Местный час (0–23) для момента времени. */
export function localHour(nowMs: number, utcOffset: number): number {
  const shifted = new Date(nowMs + utcOffset * 3600_000);
  return shifted.getUTCHours();
}

/** Попадает ли момент в тихое окно. Окно может переходить через полночь. */
export function isQuiet(nowMs: number, window: QuietWindow | null): boolean {
  if (!window) return false;
  const hour = localHour(nowMs, window.utcOffset);
  if (window.startHour < window.endHour) {
    return hour >= window.startHour && hour < window.endHour;
  }
  return hour >= window.startHour || hour < window.endHour;
}

/** Подпись для логов и админки: «23:00–08:00 (UTC+8)». */
export function quietLabel(window: QuietWindow | null): string {
  if (!window) return "выключены";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(window.startHour)}:00–${pad(window.endHour)}:00 (UTC+${window.utcOffset})`;
}
