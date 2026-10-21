from PIL import Image

im = Image.open(r"assets\banners\3_channel.png").convert("RGB")
px = im.load()
for y in (200, 300, 450, 600):
    row = []
    for x in (5, 60, 300, 600, 680, 700, 720, 740, 760, 780, 800, 820):
        row.append((x, px[x, y]))
    print("y", y, row)
