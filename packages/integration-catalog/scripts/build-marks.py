"""Build the brand tiles the catalog shows, from the reviewed list of sources.

Developer command, run by hand (needs Pillow):

    python3 packages/integration-catalog/scripts/build-marks.py [id ...]

`assets/logos/sources.json` says where each entry's mark comes from:

    {"simpleIcons": "linear"}            a simple-icons glyph (CC0), drawn on a
                                         tile in the brand colour
    {"url": "https://…/icon.png"}        the vendor's own app icon or logo
    {"same": "cloudflare"}               reuse another entry's mark

Optional keys: "fit" ("bleed" fills the tile, "inset" centres the logo on a
plain tile; default: decided from the image), "background" for an inset tile,
"color" to override a simple-icons brand colour.

Every output is a finished square tile — `assets/logos/<id>.svg` or a 128px
`<id>.png` — so the page only rounds and outlines it, and the mark reads the
same in a light and a dark theme. The script also writes `src/brandMarks.ts`,
the registry the server and the tests read. Nothing here runs at render time:
the committed files are the assets.
"""
import io
import json
import re
import sys
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LOGOS = ROOT / "assets" / "logos"
SOURCES = LOGOS / "sources.json"
REGISTRY = ROOT / "src" / "brandMarks.ts"
SIMPLE_ICONS = "16.37.0"
TILE_PX = 128
UA = {"user-agent": "polyth-integration-catalog/1"}
DANGEROUS = re.compile(
    r"<script|<foreignObject|\son[a-z]+\s*=|<iframe|<image|<use[^>]+href\s*=\s*[\"']?(?:https?:|data:)|href\s*=\s*[\"']?(?:https?:|data:|javascript:)",
    re.I,
)


def fetch(url: str, limit: int = 2_000_000) -> bytes:
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.read(limit)


def luminance(hex_color: str) -> float:
    def channel(value: int) -> float:
        c = value / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def contrast(a: str, b: str) -> float:
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


DARK_TILE = "#18181B"


def simple_icon_tile(slug: str, color: str) -> str:
    svg = fetch(f"https://cdn.jsdelivr.net/npm/simple-icons@{SIMPLE_ICONS}/icons/{slug}.svg").decode()
    paths = re.findall(r'<path[^>]*\sd="([^"]+)"', svg)
    if len(paths) != 1:
        raise ValueError(f"{slug}: expected one path, found {len(paths)}")
    # A strong brand colour carries a white glyph, the way the vendor's own app
    # icon does; a pale one (Supabase green, Hugging Face yellow) cannot hold
    # white, so it becomes the glyph on a dark tile instead.
    if contrast("#FFFFFF", color) >= 2.4:
        background, glyph = color, "#FFFFFF"
    else:
        background, glyph = DARK_TILE, color
    # The glyph box is 24 units; 34 of 64 keeps the ink well inside the
    # rounded corners on every tile.
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        f'<rect width="64" height="64" fill="{background}"/>'
        f'<path transform="translate(15 15) scale(1.4167)" fill="{glyph}" d="{paths[0]}"/>'
        "</svg>\n"
    )


def svg_tile(raw: bytes, fit: str, background: str) -> str:
    text = raw.decode("utf8", "replace")
    text = re.sub(r"<\?xml.*?\?>|<!DOCTYPE.*?>|<!--.*?-->", "", text, flags=re.S).strip()
    if DANGEROUS.search(text):
        raise ValueError("the SVG carries markup the page will not render")
    match = re.search(r"<svg\b[^>]*>", text)
    if not match:
        raise ValueError("not an SVG")
    head = match.group(0)
    view_box = re.search(r'viewBox="([^"]+)"', head)
    if not view_box:
        width = re.search(r'width="([\d.]+)', head)
        height = re.search(r'height="([\d.]+)', head)
        if not (width and height):
            raise ValueError("the SVG has no viewBox and no size")
        box = f"0 0 {width.group(1)} {height.group(1)}"
    else:
        box = view_box.group(1)
    inner = text[match.end():text.rfind("</svg>")]
    if fit == "bleed":
        return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{box}" preserveAspectRatio="xMidYMid slice">{inner}</svg>\n'
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        f'<rect width="64" height="64" fill="{background}"/>'
        f'<svg x="12" y="12" width="40" height="40" viewBox="{box}">{inner}</svg>'
        "</svg>\n"
    )


def largest_frame(raw: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(raw))
    if image.format == "ICO":
        sizes = sorted(image.info.get("sizes", {image.size}), key=max)
        image.size = sizes[-1]
    return image.convert("RGBA")


def raster_tile(raw: bytes, fit: str | None, background: str | None) -> Image.Image:
    image = largest_frame(raw)
    if max(image.size) < 64:
        raise ValueError(f"only {max(image.size)}px: too small to look sharp")
    width, height = image.size
    corners = [image.getpixel((x, y)) for x in (0, width - 1) for y in (0, height - 1)]
    opaque = all(pixel[3] > 240 for pixel in corners)
    if fit is None:
        fit = "bleed" if opaque and abs(width - height) <= 2 else "inset"
    if fit == "bleed":
        side = min(width, height)
        left, top = (width - side) // 2, (height - side) // 2
        return image.crop((left, top, left + side, top + side)).resize((TILE_PX, TILE_PX), Image.LANCZOS)

    box = image.getchannel("A").getbbox() or (0, 0, width, height)
    logo = image.crop(box)
    if background is None:
        # A light-only logo (white ink on transparency) needs a dark tile.
        pixels = logo.get_flattened_data() if hasattr(logo, "get_flattened_data") else logo.getdata()
        visible = [p for p in pixels if p[3] > 128]
        light = visible and sum(1 for p in visible if min(p[:3]) > 200) / len(visible) > 0.85
        background = DARK_TILE if light else "#FFFFFF"
    tile = Image.new("RGBA", (TILE_PX, TILE_PX), background)
    room = int(TILE_PX * 0.66)
    scale = room / max(logo.size)
    logo = logo.resize((max(1, round(logo.width * scale)), max(1, round(logo.height * scale))), Image.LANCZOS)
    tile.alpha_composite(logo, ((TILE_PX - logo.width) // 2, (TILE_PX - logo.height) // 2))
    return tile


def main() -> int:
    sources: dict = json.loads(SOURCES.read_text())
    wanted = sys.argv[1:] or list(sources)
    simple = None
    failed = 0
    for entry_id in wanted:
        source = sources.get(entry_id)
        if source is None:
            print(f"{entry_id}: not in sources.json", file=sys.stderr)
            failed += 1
            continue
        if "same" in source:
            continue
        try:
            for stale in LOGOS.glob(f"{entry_id}.*"):
                if stale.suffix in (".svg", ".png"):
                    stale.unlink()
            if "simpleIcons" in source:
                if simple is None:
                    data = json.loads(fetch(f"https://cdn.jsdelivr.net/npm/simple-icons@{SIMPLE_ICONS}/data/simple-icons.json"))
                    simple = {icon["slug"]: icon for icon in (data if isinstance(data, list) else data["icons"])}
                icon = simple[source["simpleIcons"]]
                color = source.get("color") or f"#{icon['hex']}"
                (LOGOS / f"{entry_id}.svg").write_text(simple_icon_tile(source["simpleIcons"], color))
                print(f"{entry_id}.svg  simple-icons/{source['simpleIcons']} {color}")
                continue
            raw = fetch(source["url"])
            if b"<svg" in raw[:4000].lower():
                (LOGOS / f"{entry_id}.svg").write_text(svg_tile(raw, source.get("fit", "inset"), source.get("background", "#FFFFFF")))
                print(f"{entry_id}.svg  {source['url']}")
            else:
                tile = raster_tile(raw, source.get("fit"), source.get("background"))
                # A tile is opaque, so a 256-colour palette keeps it sharp at a
                # third of the bytes of full RGBA.
                if tile.getchannel("A").getextrema()[0] == 255:
                    tile = tile.convert("RGB").quantize(colors=256)
                tile.save(LOGOS / f"{entry_id}.png", optimize=True)
                print(f"{entry_id}.png  {source['url']}")
        except Exception as cause:  # noqa: BLE001 - report every entry, then fail
            print(f"{entry_id}: {cause}", file=sys.stderr)
            failed += 1

    lines = []
    for entry_id in sorted(sources):
        owner = sources[entry_id].get("same", entry_id)
        files = [path.name for path in (LOGOS / f"{owner}.svg", LOGOS / f"{owner}.png") if path.exists()]
        if not files:
            continue
        kind = "simple-icons" if "simpleIcons" in sources[owner] else "vendor"
        lines.append(f'  "{entry_id}": {{ file: "{files[0]}", format: "{files[0][-3:]}", source: "{kind}" }},')
    REGISTRY.write_text(
        "// Generated by scripts/build-marks.py from assets/logos/sources.json. Do not edit.\n"
        'import type { BrandMark } from "./brand.ts";\n\n'
        "export const BRAND_MARKS: Readonly<Record<string, BrandMark>> = {\n"
        + "\n".join(lines)
        + "\n};\n"
    )
    if failed:
        print(f"{failed} mark(s) were not built", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
