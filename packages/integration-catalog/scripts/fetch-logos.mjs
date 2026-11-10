// Refresh the vendored brand marks. Developer command, run by hand:
//   node packages/integration-catalog/scripts/fetch-logos.mjs [id...]
//
// Downloads the vector marks into assets/logos/, refuses anything that is not a
// plain drawing, and prints what it wrote. The two raster marks are derived
// separately by scripts/derive-mask.py (see assets/logos/CREDITS.md).
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../assets/logos/", import.meta.url));

/** id -> the vendor's own vector mark. */
const SOURCES = {
  linear: "https://cdn.simpleicons.org/linear",
  github: "https://cdn.simpleicons.org/github",
  notion: "https://cdn.simpleicons.org/notion",
  atlassian: "https://cdn.simpleicons.org/atlassian",
  sentry: "https://cdn.simpleicons.org/sentry",
  supabase: "https://cdn.simpleicons.org/supabase",
  figma: "https://cdn.simpleicons.org/figma",
  stripe: "https://cdn.simpleicons.org/stripe",
  cloudflare: "https://cdn.simpleicons.org/cloudflare",
  playwright: "https://playwright.dev/img/playwright-logo.svg",
};

const DANGEROUS = /<script|<foreignObject|on[a-z]+\s*=|<iframe|<image|href\s*=\s*["']?(?:https?:|data:)/i;

const wanted = process.argv.slice(2);
const ids = wanted.length > 0 ? wanted : Object.keys(SOURCES);
let failed = 0;

await mkdir(OUT, { recursive: true });
for (const id of ids) {
  const url = SOURCES[id];
  if (!url) {
    console.error(`${id}: no source URL in this script`);
    failed += 1;
    continue;
  }
  const response = await fetch(url, { headers: { "user-agent": "polyth-integration-catalog/1" } });
  const text = await response.text();
  if (!response.ok || !text.trimStart().startsWith("<svg")) {
    console.error(`${id}: ${response.status} ${response.headers.get("content-type")} — not an SVG`);
    failed += 1;
    continue;
  }
  if (!/viewBox="[^"]+"/.test(text)) {
    console.error(`${id}: no viewBox, the mark cannot be scaled`);
    failed += 1;
    continue;
  }
  if (DANGEROUS.test(text)) {
    console.error(`${id}: the mark carries markup this page will not render`);
    failed += 1;
    continue;
  }
  const file = `${id}.svg`;
  await writeFile(`${OUT}${file}`, `${text.trim()}\n`);
  console.log(`${file} ${Buffer.byteLength(text)}b`);
}

if (failed > 0) {
  console.error(`${failed} mark(s) were not updated`);
  process.exitCode = 1;
}
