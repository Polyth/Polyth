import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

test("phone navigator opens silently instead of autofocusing search and raising the keyboard", async () => {
  const source = await read("../src/components/mobile/MobileNavigator.tsx");
  // useModalSurface with no initialFocus claims the first focusable element in
  // DOM order, which is the search <input> — that flips onFocus's searchMode
  // and pops the keyboard the instant the drawer opens. The drawer element
  // itself must be the declared focus target (Sheet/SettingsView contract).
  assert.match(source, /initialFocus:\s*"\[data-drawer-focus\]"/);
  assert.match(source, /<nav[\s\S]*?tabIndex=\{-1\}[\s\S]*?data-drawer-focus=""[\s\S]*?>/);
});

test("session swipe actions (Pin to top / Archive) stay hidden until actually swiped", async () => {
  const css = await read("../src/components/mobile/MobileNavigator.css");
  // The row only marks the underlay aria-hidden at rest; without a matching
  // visual rule the "Pin to top"/"Archive" labels paint through the row's
  // transparent background on every session row, all the time.
  assert.match(
    css,
    /\.mobile-nav-session-underlay\[aria-hidden="true"\]\s*\{\s*visibility:\s*hidden;\s*\}/,
  );
});
