"""Сборка недостающих баннеров в стиле присланных.

Приём: берём готовый баннер 3_channel.png и восстанавливаем фон в текстовой
зоне линейной интерполяцией цвета между левым краем и правой границей зоны.
Долька, логотип и градиент остаются оригинальными — швов нет.
Текст рисуется тем же DejaVu Sans Bold.

Запуск: python scripts/make_banners.py
"""

import os

from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BANNERS = os.path.join(HERE, "assets", "banners")
FONT_BOLD = os.path.join(HERE, "assets", "fonts", "DejaVuSans-Bold.ttf")
FONT_REG = os.path.join(HERE, "assets", "fonts", "DejaVuSans.ttf")

SOURCE = os.path.join(BANNERS, "3_channel.png")

# Зона, где живёт текст: левее дольки и ниже логотипа.
# Свечение дольки начинается примерно с x=650, поэтому правый ориентир
# берём до него (730..744), иначе заливка уходит в оранжевый.
CLEAR_X0, CLEAR_X1 = 0, 745
BLEND_TO = 792
TEXT_LEFT = 77
TEXT_MAX_W = 690


def clean_canvas() -> Image.Image:
    """Фон исходника с затёртой текстовой зоной (без швов)."""
    im = Image.open(SOURCE).convert("RGB")
    px = im.load()
    y_start, y_end = 128, 700

    for y in range(y_start, y_end):
        left = [0, 0, 0]
        for x in range(0, 30):
            p = px[x, y]
            for i in range(3):
                left[i] += p[i]
        left = [c // 30 for c in left]

        right = [0, 0, 0]
        for x in range(CLEAR_X1 - 16, CLEAR_X1):
            p = px[x, y]
            for i in range(3):
                right[i] += p[i]
        right = [c // 16 for c in right]

        for x in range(CLEAR_X0, BLEND_TO):
            t = (x - CLEAR_X0) / (CLEAR_X1 - CLEAR_X0)
            fill = [left[i] + (right[i] - left[i]) * t for i in range(3)]
            if x >= CLEAR_X1:
                # Плавно возвращаемся к оригиналу, чтобы не было вертикального шва.
                k = (x - CLEAR_X1) / (BLEND_TO - CLEAR_X1)
                orig = px[x, y]
                fill = [fill[i] * (1 - k) + orig[i] * k for i in range(3)]
            px[x, y] = tuple(int(c) for c in fill)
    return im


def fit_font(draw, lines, size, max_width=TEXT_MAX_W, min_size=58):
    while size > min_size:
        font = ImageFont.truetype(FONT_BOLD, size)
        if max(draw.textlength(line, font=font) for line in lines) <= max_width:
            return font, size
        size -= 2
    return ImageFont.truetype(FONT_BOLD, min_size), min_size


def badge(canvas: Image.Image, text: str, accent) -> None:
    d = ImageDraw.Draw(canvas)
    font = ImageFont.truetype(FONT_BOLD, 25)
    x0, y0, height = 75, 140, 50
    width = int(d.textlength(text, font=font)) + 74
    d.rounded_rectangle([x0, y0, x0 + width, y0 + height], radius=25, outline=accent, width=2)
    d.ellipse([x0 + 20, y0 + height // 2 - 5, x0 + 30, y0 + height // 2 + 5], fill=accent)
    d.text((x0 + 44, y0 + height / 2), text, font=font, fill=accent, anchor="lm")


def chips(canvas: Image.Image, labels, top: int = 596) -> None:
    d = ImageDraw.Draw(canvas)
    font = ImageFont.truetype(FONT_BOLD, 27)
    x = 75
    for label in labels:
        width = int(d.textlength(label, font=font)) + 52
        d.rounded_rectangle([x, top, x + width, top + 56], radius=28, outline=(98, 112, 124), width=2)
        d.text((x + width / 2, top + 28), label, font=font, fill=(240, 244, 248), anchor="mm")
        x += width + 16


def build(name, lines, subtitle_lines, chip_labels, accent=None, badge_text=None):
    canvas = clean_canvas()
    d = ImageDraw.Draw(canvas)

    top = 235 if badge_text else 187
    if badge_text:
        badge(canvas, badge_text, accent or (255, 180, 84))

    font, size = fit_font(d, lines, 92)
    y = top
    for line in lines:
        d.text((TEXT_LEFT, y), line, font=font, fill=(255, 255, 255), anchor="la")
        y += int(size * 1.12)

    sub_font = ImageFont.truetype(FONT_REG, 37)
    y += 14
    for line in subtitle_lines:
        d.text((TEXT_LEFT + 2, y), line, font=sub_font, fill=(164, 176, 188), anchor="la")
        y += 54

    chips(canvas, chip_labels)

    path = os.path.join(BANNERS, name)
    canvas.save(path, "PNG")
    print("saved", path, "title size", size)


build(
    "1_start.png",
    ["Интернет без", "блокировок"],
    ["Подключение за минуту"],
    ["Подключить", "Тарифы"],
)

build(
    "2_trial.png",
    ["3 дня", "бесплатно"],
    ["Без оплаты и без карты"],
    ["Попробовать", "Кабинет"],
    accent=(79, 227, 193),
    badge_text="Пробный доступ",
)

build(
    "7_expiring.png",
    ["Подписка", "заканчивается"],
    ["Продлите, чтобы VPN", "не отключился"],
    ["Продлить", "Бонус дня"],
    accent=(255, 180, 84),
    badge_text="Осталось мало",
)
