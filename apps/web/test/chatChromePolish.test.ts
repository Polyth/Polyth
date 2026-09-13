import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("message overflow affordances are removed from visible chat chrome", () => {
  const css = read("../src/components/chatChromePolish.css");
  assert.match(css, /\.msg-actions-entry,\s*\.msg-actions-popup,\s*\.response-footer-more\s*\{\s*display:\s*none !important;/s);
  assert.match(css, /\.msg-action-btn\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?width:\s*var\(--tap\);/s);
});

test("response footer overflow entries are flattened into direct icon controls", () => {
  const menu = read("../src/components/ui/Menu.tsx");
  assert.match(menu, /isResponseFooterOverflowTrigger\(trigger\)/);
  assert.match(menu, /className="response-footer-inline-action"/);
  assert.match(menu, /data-tooltip=\{entry\.label\}/);
  assert.match(menu, /image:\s*ChatIcon\.image/);
  assert.match(menu, /plan:\s*ChatIcon\.plan/);
  assert.match(menu, /session:\s*ChatIcon\.newSession/);
  assert.match(menu, /multirun:\s*ChatIcon\.multirun/);
});

test("response metadata surface is opaque and action geometry is consistent", () => {
  const css = read("../src/components/chatChromePolish.css");
  assert.match(css, /\.response-footer \.response-footer-metadata-grid\s*\{[^}]*background:\s*var\(--elevated\);[^}]*backdrop-filter:\s*none;/s);
  assert.match(css, /\.response-footer-actions button\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;/s);
  assert.match(css, /\.response-footer-model\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
});
