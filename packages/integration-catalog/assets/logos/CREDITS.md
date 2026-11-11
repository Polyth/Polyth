# Brand marks

Each entry shows the service's own mark as a finished square tile. The files
here are vendored, not fetched at render time: a page of vendor favicon
requests would tell two hundred third parties which integrations somebody is
browsing, and it would fail on an offline or restricted network.

`sources.json` is the reviewed list of where every tile comes from, and
`scripts/build-marks.py` turns it into the files here and `src/brandMarks.ts`.

| Kind | Source | Licence |
| --- | --- | --- |
| `{"simpleIcons": "<slug>"}` | [simple-icons](https://simpleicons.org) 16.37.0 glyph, drawn on a tile in the brand colour it records (white glyph on a strong colour; the colour as the glyph on a dark tile when it cannot hold white) | CC0 1.0 |
| `{"url": "…"}` | The vendor's own app icon or logo: its touch icon, web-app manifest icon, the icon its MCP server declares, or its GitHub organization avatar | Trademark of the service, used only to identify it |
| `{"same": "<id>"}` | Another entry's tile (Cloudflare's three servers share one) | — |

All names and marks are trademarks of their owners; they appear here to name
the integration, not to claim any endorsement.

Refresh one tile or all of them, then look at every changed tile on a light and
a dark page before committing:

```sh
python3 packages/integration-catalog/scripts/build-marks.py [id ...]
```

A raster below 64px is refused (it would be blurry at 2x), an SVG with script,
event handlers or external references is refused, and the tests check that
every entry has a tile, every tile is square and sharp enough, and every tile
names exactly one reviewed source.
