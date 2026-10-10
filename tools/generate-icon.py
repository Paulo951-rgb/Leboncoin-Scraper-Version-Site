#!/usr/bin/env python3
"""Génère build/icon.ico (multi-résolutions) pour Leboncoin Scraper Pro.

Icône : carré arrondi dégradé orange (couleur Leboncoin) avec un graphique de
barres (annonces) et une loupe. Rejouable : `python3 tools/generate-icon.py`.

Dépendance : Pillow (`pip install pillow`). Utilisé pour régénérer l'icône sans
outil graphique externe ; le résultat versionné est build/icon.ico.
"""
import os
from PIL import Image, ImageDraw

SIZE = 256
ORANGE = (255, 110, 20)
ORANGE_DARK = (214, 82, 10)
RADIUS = 48


def build_image():
    img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    for y in range(SIZE):
        t = y / (SIZE - 1)
        color = tuple(int(ORANGE[i] * (1 - t) + ORANGE_DARK[i] * t) for i in range(3))
        d.line([(0, y), (SIZE, y)], fill=(*color, 255))

    mask = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, fill=255)
    img.putalpha(mask)

    d = ImageDraw.Draw(img)
    for (x0, y0, x1, y1) in [(60, 150, 84, 200), (96, 120, 120, 200), (132, 90, 156, 200)]:
        d.rounded_rectangle([x0, y0, x1, y1], radius=6, fill=(255, 255, 255, 210))

    cx, cy, rr = 168, 150, 44
    d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=(255, 255, 255, 255), width=12)
    d.line([(cx + 30, cy + 30), (cx + 52, cy + 52)], fill=(255, 255, 255, 255), width=14)
    return img


def main():
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'build')
    os.makedirs(out_dir, exist_ok=True)
    img = build_image()
    img.save(os.path.join(out_dir, 'icon.png'))
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    ico_path = os.path.join(out_dir, 'icon.ico')
    img.save(ico_path, format='ICO', sizes=sizes)
    print(f'icon.ico written: {ico_path} ({os.path.getsize(ico_path)} bytes)')


if __name__ == '__main__':
    main()
