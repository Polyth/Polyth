// Moved from packages/code-hosting/test: the shared hosting surface renders
// provider-supplied wording, so the GitHub-specific labels belong to the
// package that owns them rather than to the shared (framework) surface's test.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import type { WebPackageHost } from "@polyth/web-sdk";
import { en } from "../src/i18n/en.ts";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { githubProvider } = await import("../widgets/GithubView.tsx");

const messages = en as unknown as Record<string, string>;
const translate = (key: string, values: Record<string, string | number> = {}): string =>
  (messages[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
    values[name] === undefined ? match : String(values[name]));
const host = {
  ui: {
    locale: { translate },
    icons: {},
  },
} as unknown as WebPackageHost;

test("the github provider supplies the shared hosting surface with its own labels", () => {
  const provider = githubProvider(host);
  assert.equal(provider.id, "github");
  assert.equal(provider.apiBase, "/api/github");
  assert.equal(provider.presentation.serviceName, "GitHub");
  assert.equal(provider.presentation.issuePlural, "Issues");
  assert.equal(provider.presentation.changePlural, "Pull requests");
  assert.equal(provider.t("githubview.closed"), "Closed");
  assert.equal(provider.t("githubview.open"), "Open");
  assert.equal(provider.t("githubview.searchValue", { value: "pull requests" }), "Search pull requests");
});
