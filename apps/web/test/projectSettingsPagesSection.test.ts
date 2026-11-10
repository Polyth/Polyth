import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Settings → Projects reaches every project settings page, Repositories included", () => {
  const pages = source("../src/components/settings/pages.tsx");
  // Rendered for the project chosen on the page, not the sidebar's active one.
  assert.match(pages, /<ProjectSettingsPagesSection project=\{selectedProject\} \/>/);
  // Generic over package contributions: the host never names a package page.
  assert.match(pages, /const pages = listProjectSettings\(project\.id\);/);
  assert.match(pages, /subscribeProjectSettings\(/);
  assert.doesNotMatch(pages, /files\.repositories/);
  // Opens the same dialog page the project menu opens.
  assert.match(pages, /initialPage=\{`contribution:\$\{openId\}`\}/);
});

test("Settings search finds the section by repository words", () => {
  const registry = source("../src/settings/registry.ts");
  assert.match(registry, /id: "projects\.pages", pageId: "projects",[^\n]*"repositories"/);
});
