/**
 * QR-код без внешних сервисов.
 *
 * Ссылка на подписку — это и есть ключ доступа, поэтому отдавать её стороннему
 * генератору картинок нельзя. Кодируем на месте и рисуем SVG: он масштабируется
 * без потерь и не требует ни canvas, ни шрифтов.
 */

import qrcode from "qrcode-generator";

export interface QrOptions {
  /** Сторона квадрата в пикселях (viewBox, не реальный размер). */
  size?: number;
  /** Тихая зона в модулях. Спецификация требует минимум 4. */
  margin?: number;
  dark?: string;
  light?: string;
}

/**
 * Возвращает готовый `<svg>` с QR-кодом текста.
 * Уровень коррекции M: ссылка короткая, а M устойчив к лёгким потёртостям
 * экрана и блику при сканировании с монитора.
 */
export function qrSvg(text: string, options: QrOptions = {}): string {
  const size = options.size ?? 220;
  const margin = Math.max(0, options.margin ?? 4);
  const dark = options.dark ?? "#0B1220";
  const light = options.light ?? "#FFFFFF";

  let qr: ReturnType<typeof qrcode>;
  try {
    qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
  } catch {
    // Слишком длинный текст для выбранного уровня — понижаем коррекцию,
    // а не отдаём панель без кода.
    qr = qrcode(0, "L");
    qr.addData(text);
    qr.make();
  }

  const count = qr.getModuleCount();
  const total = count + margin * 2;
  // Целый размер модуля: дробные координаты дают щели в один пиксель, и камера
  // на границе модулей читает такой код хуже, чем ровную сетку.
  const module = Math.max(1, Math.floor(size / total));
  const side = module * total;

  let path = "";
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      const x = (col + margin) * module;
      const y = (row + margin) * module;
      path += `M${x} ${y}h${module}v${module}h-${module}z`;
    }
  }

  return `<svg class="qr" viewBox="0 0 ${side} ${side}" width="${side}" height="${side}" role="img" aria-label="QR-код">
  <rect width="${side}" height="${side}" fill="${light}"/>
  <path d="${path}" fill="${dark}"/>
</svg>`;
}
