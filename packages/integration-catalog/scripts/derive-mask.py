"""Turn a vendor favicon (solid background, light glyph) into an alpha-only
glyph, so a raster mark sits on the same tinted tile as the vector marks.

Developer command, run by hand:

    python3 packages/integration-catalog/scripts/derive-mask.py <favicon> <id>

Needs Pillow. The input can be an .ico with a 256px frame or a PNG.
"""
import sys
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "assets" / "logos"


def derive(source: Path, entry_id: str) -> Path:
    image = Image.open(source).convert("RGBA")
    pixels = image.load()
    width, height = image.size

    background = pixels[0, 0][:3]
    floor = sum(background) / 3
    # Normalise against the brightest glyph pixel, found on a coarse grid.
    peak = max(sum(pixels[x, y][:3]) / 3 for x in range(0, width, 3) for y in range(0, height, 3))
    span = max(peak - floor, 1)

    mask = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    target = mask.load()
    for y in range(height):
        for x in range(width):
            red, green, blue, alpha = pixels[x, y]
            if alpha == 0:
                continue
            value = (red + green + blue) / 3
            out = max(0, min(255, round((value - floor) / span * 255)))
            if out >= 8:
                target[x, y] = (255, 255, 255, out)

    box = mask.getchannel("A").getbbox()
    if box:
        mask = mask.crop(box)
    side = max(mask.size)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(mask, ((side - mask.width) // 2, (side - mask.height) // 2), mask)
    path = OUT / f"{entry_id}.png"
    square.resize((256, 256), Image.LANCZOS).save(path, optimize=True)
    return path


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    written = derive(Path(sys.argv[1]), sys.argv[2])
    print(f"{written.relative_to(OUT.parent.parent.parent)} {written.stat().st_size}b")
