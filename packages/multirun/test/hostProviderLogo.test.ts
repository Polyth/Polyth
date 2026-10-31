// The multi-run view is the one surface that brands its own ProviderLogo slot
// with `multirun-provider-logo`. That class is this package's own UI detail, so
// it is asserted here; the host provider-logo test discovers whichever package
// surfaces are present and audits them generically.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("the multi-run view brands its ProviderLogo as a bare logo", async () => {
  const [view, css] = await Promise.all([
    read("../widgets/MultiRunView.tsx"),
    read("../widgets/styles.css"),
  ]);
  assert.match(view, /<ProviderLogo[^>]*\bclassName="[^"]*multirun-provider-logo/, "the run row renders the branded logo");
  assert.match(css, /\.multirun-provider-logo(?![\w-])[^{}]*\{/, "the class owns a CSS rule");
});
