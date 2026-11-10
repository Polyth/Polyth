# Brand marks

Each entry shows the service's own glyph. The files here are vendored, not
fetched at render time: a page of vendor favicon requests would tell a dozen
third parties which integrations somebody is browsing, and it would fail on an
offline or restricted network.

| Mark | Source | Licence |
| --- | --- | --- |
| `linear`, `github`, `notion`, `atlassian`, `sentry`, `supabase`, `figma`, `stripe`, `cloudflare` | [simple-icons](https://simpleicons.org) via `cdn.simpleicons.org/<slug>` | CC0 1.0 |
| `playwright` | `playwright.dev/img/playwright-logo.svg` | MIT (Playwright project) |
| `exa` | `exa.ai/favicon.ico` | service trademark, used only to identify the service |
| `context7` | `context7.com/favicon.ico` | service trademark, used only to identify the service |

The four names above the vendor marks are trademarks of their owners; they
appear here to name the integration, not to claim any endorsement.

`exa.png` and `context7.png` are alpha-only glyphs derived from the vendor
favicon by `scripts/derive-mask.py`, so they sit on the same tinted tile as the
vector marks instead of arriving as a coloured square.

Refresh the vector marks with `node packages/integration-catalog/scripts/fetch-logos.mjs`
and a raster mark with `python3 packages/integration-catalog/scripts/derive-mask.py <favicon> <id>`.
Both are developer commands run by hand; the committed files are the assets.
