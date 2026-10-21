from PIL import Image

im = Image.open(r"assets\banners\4_devices.png").convert("RGB")
W, H = im.size
px = im.load()

LEFT, RIGHT = 60, 720


def lum(p):
    return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]


rows = [y for y in range(H) if any(lum(px[x, y]) > 120 for x in range(LEFT, RIGHT, 2))]
blocks = []
start = None
prev = None
for y in rows:
    if start is None:
        start = y
    elif y - prev > 6:
        blocks.append((start, prev))
        start = y
    prev = y
if start is not None:
    blocks.append((start, prev))

print("blocks:")
for a, b in blocks:
    xs = [x for x in range(LEFT, RIGHT) if any(lum(px[x, y]) > 120 for y in range(a, b + 1, 2))]
    sample = px[(min(xs) + 20) if xs else 80, (a + b) // 2]
    print("  y", a, "-", b, "h", b - a, "x", (min(xs), max(xs)) if xs else None, "color", sample)

# чипы внизу
chip_rows = [y for y in range(560, H) if any(lum(px[x, y]) > 110 for x in range(LEFT, 700, 2))]
print("chips y:", (min(chip_rows), max(chip_rows)) if chip_rows else None)
if chip_rows:
    y = (min(chip_rows) + max(chip_rows)) // 2
    xs = [x for x in range(LEFT, 720) if lum(px[x, y]) > 110]
    print("chips x span:", min(xs), max(xs))
