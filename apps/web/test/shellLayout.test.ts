// Settings → Appearance → Window layout: the preference record, the resolver
// that decides where each former top-bar group lives, and the CSS contract
// that keeps the full-height geometry out of the classic shell.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseUiSettings, UI_DEFAULTS, SHELL_LAYOUTS } from "../src/uiPrefs.ts";
import { resolveShellLayout, shellBarReserves, shellColumnGroups } from "../src/shellLayout.ts";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("a fresh window is bare with floating columns; saved profiles keep theirs; parsing is defensive", () => {
  const fresh = parseUiSettings(null);
  // No top bar: the chat between two floating columns, the tools in the
  // launcher strip, search, notifications, Settings and the account at the
  // foot of the navigator's column.
  assert.equal(fresh.shellLayout, "bare");
  assert.equal(UI_DEFAULTS.shellLayout, "bare");
  assert.equal(fresh.shellBarStyle, "spread");
  assert.equal(fresh.floatingColumns, true);
  assert.equal(fresh.shellToolsDock, "end");
  assert.equal(fresh.shellActionsDock, "start");
  assert.equal(fresh.shellTitle, "chat");
  // An existing profile without the fields keeps the window it was built
  // with: the classic shell, and the actions in the strip if it goes bare.
  const saved = parseUiSettings("{}");
  assert.equal(saved.shellLayout, "classic", "nobody's window changes until they pick a layout");
  assert.equal(saved.shellActionsDock, "end");
  for (const layout of SHELL_LAYOUTS) assert.equal(parseUiSettings(JSON.stringify({ shellLayout: layout })).shellLayout, layout);
  const bogus = parseUiSettings(JSON.stringify({
    shellLayout: "sideways", shellBarStyle: 3, floatingColumns: "yes", shellToolsDock: "top", shellActionsDock: null, shellTitle: "both",
  }));
  assert.equal(bogus.shellLayout, "classic");
  assert.equal(bogus.shellBarStyle, "spread");
  assert.equal(bogus.floatingColumns, true);
  assert.equal(bogus.shellToolsDock, "end");
  assert.equal(bogus.shellActionsDock, "end", "an unreadable field falls back like a missing one");
  assert.equal(bogus.shellTitle, "chat");
  const kept = parseUiSettings(JSON.stringify({
    shellLayout: "bare", shellBarStyle: "island", floatingColumns: false, shellToolsDock: "start", shellActionsDock: "hidden", shellTitle: "hidden",
  }));
  assert.deepEqual(
    [kept.shellLayout, kept.shellBarStyle, kept.floatingColumns, kept.shellToolsDock, kept.shellActionsDock, kept.shellTitle],
    ["bare", "island", false, "start", "hidden", "hidden"],
  );
});

test("the resolver gives every top-bar group one home per layout", () => {
  const prefs = { ...UI_DEFAULTS, shellLayout: "classic" as const };
  // Tablets and phones always keep their own headers.
  for (const mode of ["compact", "phone"] as const) {
    assert.equal(resolveShellLayout({ ...prefs, shellLayout: "bare" }, mode).layout, "classic");
  }
  const classic = resolveShellLayout(prefs, "wide");
  assert.deepEqual(
    [classic.layout, classic.tools, classic.actions, classic.account, classic.title, classic.floating],
    ["classic", "bar", "bar", "bar", true, false],
  );
  const columns = resolveShellLayout({ ...prefs, shellLayout: "columns", shellBarStyle: "island" }, "wide");
  assert.deepEqual(
    [columns.layout, columns.barStyle, columns.tools, columns.actions, columns.account, columns.floating],
    ["columns", "island", "bar", "bar", "bar", true],
  );
  const bare = resolveShellLayout({
    ...prefs, shellLayout: "bare", shellToolsDock: "start", shellActionsDock: "hidden", shellTitle: "hidden", floatingColumns: false,
  }, "wide");
  assert.deepEqual(
    [bare.layout, bare.tools, bare.actions, bare.account, bare.title, bare.floating],
    ["bare", "start", "hidden", "start", false, false],
  );
  // Hidden actions leave the account at the navigator's foot, still reachable.
  assert.deepEqual(shellColumnGroups(bare, "start"), { tools: true, actions: false, account: true });
  assert.deepEqual(shellColumnGroups(bare, "end"), { tools: false, actions: false, account: false });
  // The account menu travels with search and notifications.
  for (const side of ["start", "end"] as const) {
    const docked = resolveShellLayout({ ...prefs, shellLayout: "bare", shellActionsDock: side }, "wide");
    assert.equal(docked.account, side);
    const other = side === "start" ? "end" : "start";
    assert.deepEqual(shellColumnGroups(docked, side), { tools: docked.tools === side, actions: true, account: true });
    assert.equal(shellColumnGroups(docked, other).account, false);
  }
  // In the bar layouts no column hosts a group.
  assert.deepEqual(shellColumnGroups(columns, "end"), { tools: false, actions: false, account: false });
  // The full-height navigators start with their own controls: the Polyth mark
  // has no home outside the classic bar, in Columns as well as No bar.
  assert.equal(Object.hasOwn(columns, "brand"), false);
  assert.equal(Object.hasOwn(bare, "brand"), false);
});

test("full-height geometry is a token-only layer that never touches the classic shell", async () => {
  const [css, main, app] = await Promise.all([
    read("../src/shellLayout.css"),
    read("../src/main.tsx"),
    read("../src/App.tsx"),
  ]);
  // Loaded after the theme style recipes, so it composes with all of them.
  assert.ok(main.indexOf('import "./shellLayout.css"') > main.indexOf('import "./liquidGlassTheme.css"'));
  // App owns the one attribute CSS reads, for the shell mode it rendered.
  assert.match(app, /usePublishShellLayout\(resolveShellLayout\(ui, shellMode\)\)/);
  // Colours and materials stay with the theme: no literal colours here.
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "no hex colours");
  assert.doesNotMatch(css.replace(/color-mix\([^;]*\)/g, ""), /\brgba?\(/, "no literal rgb colours");
  // Every shell rule is gated on a full-height layout; classic is untouched.
  const shellRules = css.match(/^[^\n{}@/]*(?:\.app\b|\.app-shell|\.railbar|\.sidebar\b)[^\n{]*\{/gm) ?? [];
  assert.ok(shellRules.length > 0);
  for (const rule of shellRules) {
    // The island capsule exists only while the island bar renders.
    assert.match(rule, /body(?:\.desktop-app)?[^ ]*\[data-shell-(?:layout|floating)|\.sidebar-project-rail:has|\.sidebar-collapsed-rail|> \.shell-island/, `scoped: ${rule.trim()}`);
  }
  assert.doesNotMatch(css, /data-shell-layout="classic"/, "classic has no rules of its own");
});

test("in the full-height layouts the layout's column geometry outranks every look", async () => {
  const [css, looks] = await Promise.all([read("../src/shellLayout.css"), read("../src/shellLooks.css")]);
  // A look shapes the classic columns at id strength with !important (the
  // Monoliths' workspace margins once let the bar cover the chat), so the
  // geometry the layout depends on restates itself above them.
  const strong = (selector: string, declaration: string) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `missing rule ${selector}`);
    assert.ok(css.slice(at, css.indexOf("}", at)).includes(declaration), `${selector} lacks ${declaration}`);
  };
  const full = 'body:is([data-shell-layout="columns"], [data-shell-layout="bare"]):not(#\\#) .app-shell';
  strong(`${full} > .workspace`, "margin-block-start: var(--shell-bar-block) !important");
  strong(`${full} > .sidebar`, "margin-block: var(--shell-edge) !important");
  strong(`${full} > .sidebar`, "height: auto !important");
  strong(`${full} > .railbar.railbar-open:not(:has(> .rail-fullscreen))`, "margin-block: var(--shell-edge) !important");
  // Air and Obsidian start-align their classic strip; the full-height strip
  // stretches whatever the look says.
  strong(`${full} > .railbar:not(.railbar-open)`, "align-self: stretch !important");
  strong(
    'body[data-shell-floating="true"]:is([data-shell-layout="columns"], [data-shell-layout="bare"]):not(#\\#) .app-shell > .sidebar',
    "border-radius: var(--look-column-radius, var(--radius-surface)) !important",
  );
  // Under a look the island is one capsule in the look's float material.
  assert.match(looks, /\.app > \.header > \.shell-island \{\n  background: color-mix\(in srgb, var\(--look-float\) var\(--look-float-a\), transparent\) !important;/);
});

test("the bar between full-height columns stops a column gap before the strip and a floating window", () => {
  // Workspace lane 340–1440, column gap 8: the idle strip overlays 1397–1440.
  const lane = { left: 340, right: 1440 };
  assert.deepEqual(shellBarReserves(lane, [{ left: 1397, right: 1440 }], 8), { left: 0, right: 51 });
  // A floating window (960–1397) beside the strip pushes the bar's end in
  // front of the window, so the title and header actions stay uncovered.
  assert.deepEqual(shellBarReserves(lane, [{ left: 1397, right: 1440 }, { left: 960, right: 1397 }], 8), { left: 0, right: 488 });
  // Mirrored shell: the strip overlays the lane's start.
  assert.deepEqual(shellBarReserves({ left: 0, right: 1100 }, [{ left: 0, right: 43 }], 8), { left: 51, right: 0 });
  // A pinned window takes its own lane and a closed one has no box.
  assert.deepEqual(shellBarReserves(lane, [{ left: 1440, right: 1880 }, { left: 0, right: 0 }], 8), { left: 0, right: 0 });
});
