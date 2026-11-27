# Blocked pages: use Bladebro

Bladebro drives a real Chrome or Chromium with a consistent fingerprint. Reach
for it only after the usual path failed because of bot protection:

- a fetch (web_fetch, WebFetch, curl) returns a challenge page: "Just a
  moment…", "Performing security verification", "Verify you are human",
  "Access denied", "Please enable JavaScript", or a 403/429/503 from
  Cloudflare, Akamai, DataDome, PerimeterX and the like;
- a headless browser or Playwright lands on a captcha or a blank page.

For ordinary pages keep using the normal tools: they are cheaper.

## Where the tools are

- The `bladebro` MCP server gives five tools: `act`, `see`, `state`, `run` and
  `vision`. Your harness may show them with a prefix, such as
  `mcp__bladebro__see`. Without native MCP tools, call them through
  `polyth_mcp` (`list`, then `call` with the bladebro server's id).
- No MCP tools, but a `bladebro` command on PATH: the shell has the same verbs,
  `bladebro nav <url>`, `bladebro see content`, `bladebro act click …`,
  `bladebro vision`. `bladebro help <command>` gives exact syntax.

## Recipe

1. `act` with `action: "navigate"` and the `url`. The reply carries element
   refs, a content preview and, on a wall, a `⚠ blocked: <vendor>` line with
   remediation hints.
2. Still blocked: `act` with `action: "wait"` (10 seconds by default), then
   `see` with `mode: "content"`. Turnstile and JavaScript checks often pass by
   themselves.
3. Still blocked: `vision` returns a screenshot. Find the "Verify you are
   human" checkbox and click it with `act`, `action: "click"`, `x` and `y` in
   the screenshot's pixels (viewport CSS pixels). Wait about 8 seconds, then
   `see` again.

To read data rather than prose, `see` with `extract: "auto"` returns lists,
products and tables. One call can navigate and read: `see` with `url` and
`mode: "content"`.

## Rules

- **Shared browser.** One browser profile serves every agent on this machine
  and keeps cookies between runs. Do not sign in to accounts, and do not clear
  cookies or storage.
- **No secrets.** Never type a password, token or one-time code into a page.
  Sign-in, consent and two-factor steps belong to the person: stop and ask.
- **Two tries, then stop.** If an image or puzzle captcha, or the wall itself,
  remains after the wait and two checkbox attempts, stop and tell the person
  what you saw, with the `vision` screenshot. Do not loop.
- **Be polite.** Open only what the task needs, pace repeated requests and do
  not crawl in bulk. Do not use it to get around logins, paywalls or rate
  limits the person is not entitled to bypass.

## When Bladebro itself fails

- `Chrome launch failed … SingletonLock: Permission denied`: the browser is a
  Linux snap, which cannot write hidden folders. Bladebro needs `BLADE_HOME`
  set to a folder under `~/snap/chromium/common/`. Polyth's catalog sets it
  when it connects Bladebro on such a machine; report it rather than moving
  folders around.
- `no prebuilt binary` or a missing platform package: report it; do not
  install software on your own.
