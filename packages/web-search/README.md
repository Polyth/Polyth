# Web Search

`@polyth/web-search` is the first-party owner of agent web discovery and page
reading. Package enablement contributes one deployment skill and two network
tools (`web_search`, `web_fetch`); disablement removes them and cancels
package-owned in-flight work. Like every package tool they reach every shipped
harness through the generic `polyth-agent-tools` MCP projection.

## Agent surface

- `web_search` accepts a query, an optional result count (`1..10`), and an
  optional day/week/month/year freshness filter.
- `web_fetch` reads one public page by URL and returns its main content as
  Markdown with absolute links, plus title and description. It is a plain
  bounded HTTP read with no browser engine, JavaScript or cookies, so it costs
  milliseconds. Input: `url`, optional `offset` and `maxChars` (1,000–15,000,
  default 12,000, which keeps one window under the bridge's 16k inline-output
  limit). Long pages come in windows that end on paragraph breaks; the header
  names the next `offset`, and continuation windows reuse a five-minute
  per-Space read cache so offsets stay stable.
- The `polyth-web-search` skill routes agents to the lightest tool: search to
  find sources, `web_fetch` to read them, `polyth_browser` (controlled
  Chromium, `@polyth/browser`) only for pages that need JavaScript, sign-in or
  interaction. It also covers query refinement, verification and citation.
- Network tools use Polyth's canonical package-tool permission flow. Search
  queries are not auto-approved merely because the package is enabled.
- Search output is bounded structured JSON; `web_fetch` output is plain text
  (a short `Key: value` header, then the page). Titles, snippets, URLs, and
  fetched page content are explicitly treated as untrusted discovery data.

## Providers

- **DuckDuckGo** is the keyless default and is always available while the
  package is enabled.
- **Tavily** is optional. Only a global `token` or `env` Credential Vault handle can be selected;
  its plaintext is resolved inside the server callback that performs the
  request and never enters settings DTOs, tool arguments, events, or logs.
- `auto` prefers Tavily when configured and falls back to DuckDuckGo for an
  invalid/expired credential, provider failure, rate limit, or exhausted plan.
  Explicit Tavily selection fails honestly instead of changing providers.
- Provider calls use HTTPS origin allowlists, DNS resolution with private and
  metadata address blocking, and a pinned socket for the validated address.
  Redirects are not followed. Timeouts, response-size limits, cancellation,
  per-Space concurrency, queue depth, and request pacing are enforced by the
  package.

## Page reading (`web_fetch`)

- Only `http`/`https` URLs without embedded credentials. Every hop, including
  each of at most five redirects, is resolved and checked with
  `@polyth/outbound` `public-only` policy (private, loopback, link-local and
  metadata addresses are refused) and then connected through a socket pinned to
  the validated address. Agents use local tools for localhost and private
  services.
- Bounds: 20 s timeout, 5 MiB on the wire, 10 MiB after gzip/deflate/brotli
  decompression, 3 M characters parsed, four concurrent reads and 16 queued per
  Space.
- Text only: HTML/XHTML become Markdown; Markdown, plain text, XML/RSS/Atom
  pass through; JSON is pretty-printed. PDFs and other binaries fail with
  `fetch-unsupported` instead of returning garbage. The charset comes from the
  header, a BOM or `<meta charset>`.
- Extraction (`src/extract.ts`, owned code, no dependency) prefers one
  dominant `<article>`, then `<main>`, then the body; it drops scripts, styles,
  forms, `nav`/`aside`, page-level footers/banners, hidden and `aria-hidden`
  nodes, cookie/consent banners, language switchers (`hreflang`) and heading
  permalinks. Code blocks keep their language; tables become Markdown tables.
  A page with almost no text but app-shell markup gets a note pointing to
  `polyth_browser`.
- HTTP 4xx/5xx fail with `fetch-http-error`. Many sites (for example npm,
  Reddit, Stack Overflow, Medium) refuse requests from data-centre addresses
  regardless of User-Agent; `web_fetch` identifies itself honestly as
  `Polyth/1.0` and reports the refusal instead of impersonating a browser.
- `web_fetch` is not gated by the **Allow web search** switch: it sends no
  query to a search provider, and the controlled browser can already read the
  same pages. It uses the same package-tool permission flow as `web_search`.

## Settings and storage

`GET /api/web-search/settings` returns revisioned Space settings, provider
availability, Vault availability, and global handle metadata only.
`PUT /api/web-search/settings` validates the complete settings document and an
`expectedRevision`; stale writes fail with `409` instead of overwriting a
newer choice.

Settings are stored at `<Space>/packages/web-search/settings.json` through the
host-provided Space storage seam and atomic replacement. The paired-device
route policy is local-only; there is no generic proxy or custom search route.

## Package UI

The package registers **Settings → Engineering → Web Search** through
`@polyth/web-sdk`. It can enable/disable search, select provider/region/safe
search/result limit, and choose a global Credential Vault handle for Tavily.
The page never accepts or displays a Tavily secret.

## Verification

Run focused tests first, then the package typecheck and web build:

```sh
node --experimental-strip-types --test packages/web-search/test/*.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/web-search
npm run build:web
```

The tests use injected transports, resolvers and temporary Space directories.
They do not require DuckDuckGo, Tavily, a live page or a paid provider turn.
