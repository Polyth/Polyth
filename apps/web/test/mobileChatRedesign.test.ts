// UX-MOBILE-01 permanent regression tests for the mobile-first new chat.
//
// Two kinds of assertions:
//   * pure unit tests for the geometry and starter models (no DOM needed);
//   * source/CSS contracts for the rules that only exist as markup or style —
//     keyboard-safe overlays, tap targets, overflow guards, and the composer's
//     collapsed/expanded states.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { readWebStyles } from "./webStyles.ts";

// TSX loader: the metadata line is asserted against the real component module.
register("./tsxHooks.mjs", import.meta.url);
import {
  KEYBOARD_MIN_INSET,
  keyboardInsetFrom,
  metricsFrom,
} from "../src/mobileViewport.ts";
import {
  BUILTIN_STARTERS,
  contextualStarterIds,
  EMPTY_STARTER_CONTEXT,
  matchesStarter,
  parseStarterPrefs,
  recordStarterUse,
  reorderPinned,
  serializeStarterPrefs,
  setHidden,
  starterCategories,
  starterContextFrom,
  STARTER_RECENTS_MAX,
  togglePinned,
  visibleStarters,
  withCustomStarter,
  withoutCustomStarter,
  type StarterPrefs,
} from "../src/starters.ts";
import { defaultModelPrefs, reorderFavorite } from "@polyth/models";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");
const prefs = (patch: Partial<StarterPrefs> = {}): StarterPrefs =>
  ({ pinned: [], hidden: [], recents: [], custom: [], ...patch });

// ---- visual viewport geometry ----------------------------------------------

test("the keyboard inset is the strip of the layout viewport it covers", () => {
  // 932pt layout, 596pt visible, page not scrolled → 336pt of keyboard.
  assert.equal(keyboardInsetFrom(932, 596, 0), 336);
  // Visual viewport pushed down (pinch/scroll) counts against the strip.
  assert.equal(keyboardInsetFrom(932, 596, 36), 300);
});

test("browser chrome collapse is not reported as a keyboard", () => {
  assert.equal(keyboardInsetFrom(932, 932, 0), 0);
  assert.equal(keyboardInsetFrom(932, 932 - (KEYBOARD_MIN_INSET - 1), 0), 0);
  assert.equal(keyboardInsetFrom(932, 932 - KEYBOARD_MIN_INSET, 0), KEYBOARD_MIN_INSET);
  // A visual viewport larger than the layout box never yields a negative inset.
  assert.equal(keyboardInsetFrom(800, 860, 0), 0);
});

test("metrics round pixels and always describe the visible band", () => {
  assert.deepEqual(metricsFrom(932, 595.5, 0.4), { height: 596, keyboardInset: 336, offsetTop: 0, covering: true });
});

test("a visual viewport that sits lower in a full-height page is not a keyboard", () => {
  // iOS Safari: the layout viewport never shrinks; the page scrolls behind the
  // keyboard. The frame must shift up to follow the input — but content must
  // NOT be reflowed as if the layout got shorter.
  assert.deepEqual(metricsFrom(932, 596, 336), { height: 596, keyboardInset: 0, offsetTop: 336, covering: false });
  assert.equal(keyboardInsetFrom(932, 596, 336), 0, "no inset: the layout viewport was not resized");
  assert.equal(keyboardInsetFrom(932, 932, 400), 0, "a repositioned full-height viewport is idle");
});

// ---- starter model ----------------------------------------------------------

test("built-in starters are unique, labelled, and carry a prompt", () => {
  const ids = new Set<string>();
  for (const starter of BUILTIN_STARTERS) {
    assert.ok(starter.id.startsWith("builtin:"), `${starter.id} is namespaced`);
    assert.ok(!ids.has(starter.id), `${starter.id} appears once`);
    ids.add(starter.id);
    assert.ok(starter.label.length > 0 && starter.label.length <= 24, `${starter.id} has a chip-sized label`);
    assert.ok(starter.prompt.trim().length > 0, `${starter.id} has a prompt`);
    assert.equal(starter.source, "builtin");
  }
});

test("suggestions follow the real workspace state", () => {
  const dirty = contextualStarterIds({ ...EMPTY_STARTER_CONTEXT, changedFiles: 4 });
  assert.equal(dirty[0], "builtin:review-changes");
  assert.ok(dirty.includes("builtin:commit"));

  const conflicted = contextualStarterIds({ ...EMPTY_STARTER_CONTEXT, changedFiles: 2, conflicted: 1 });
  assert.equal(conflicted[0], "builtin:resolve-conflicts");

  const finished = contextualStarterIds({ ...EMPTY_STARTER_CONTEXT, lastTurnFinished: true, hasHistory: true });
  assert.equal(finished[0], "builtin:review-result");
  assert.equal(finished[1], "builtin:continue");

  const clean = contextualStarterIds(EMPTY_STARTER_CONTEXT);
  assert.equal(clean[0], "builtin:explore");
  assert.ok(clean.includes("builtin:plan-feature"));
  // Every state still terminates in the clean-repo list, so any slice works.
  for (const ids of [dirty, conflicted, finished, clean]) {
    assert.ok(ids.includes("builtin:architecture"), "the ordering is total");
    assert.equal(new Set(ids).size, ids.length, "no duplicates survive");
  }
});

test("git status maps onto the starter context", () => {
  assert.deepEqual(
    starterContextFrom(
      { staged: [1], unstaged: [1, 2], untracked: [], conflicted: [1], ahead: 2 },
      { hasHistory: true, lastTurnFinished: false },
    ),
    { changedFiles: 3, conflicted: 1, ahead: 2, hasHistory: true, lastTurnFinished: false },
  );
  assert.deepEqual(
    starterContextFrom(null, { hasHistory: false, lastTurnFinished: false }),
    EMPTY_STARTER_CONTEXT,
  );
});

test("pinned starters lead, hidden ones never appear, and the row is clipped", () => {
  const visible = visibleStarters(
    prefs({ pinned: ["builtin:debug"], hidden: ["builtin:review-changes"] }),
    { ...EMPTY_STARTER_CONTEXT, changedFiles: 3 },
    3,
  );
  assert.equal(visible[0]?.id, "builtin:debug");
  assert.ok(!visible.some((starter) => starter.id === "builtin:review-changes"));
  assert.equal(visible.length, 3);
  assert.equal(visibleStarters(prefs(), EMPTY_STARTER_CONTEXT, 2).length, 2);
});

test("commands and skills join the same catalog", () => {
  const visible = visibleStarters(
    prefs({ pinned: ["command:test", "skill:review"] }),
    EMPTY_STARTER_CONTEXT,
    2,
    { commands: [{ name: "test" }], skills: [{ name: "review" }] },
  );
  assert.deepEqual(visible.map((starter) => starter.id), ["command:test", "skill:review"]);
  assert.equal(visible[0]?.prompt, "/test");
  assert.equal(visible[1]?.prompt, "#review");
});

test("picker categories drop empty groups and keep favorites first", () => {
  const groups = starterCategories(prefs({ pinned: ["builtin:debug"] }), EMPTY_STARTER_CONTEXT);
  assert.equal(groups[0]?.id, "favorites");
  assert.ok(!groups.some((group) => group.id === "custom"), "no empty custom group");
  assert.ok(groups.some((group) => group.id === "builtin"));
});

test("starter search matches label, description, and prompt", () => {
  const starter = BUILTIN_STARTERS.find((item) => item.id === "builtin:commit")!;
  assert.ok(matchesStarter(starter, "commit"));
  assert.ok(matchesStarter(starter, "COMMIT MESSAGE"));
  assert.ok(matchesStarter(starter, ""));
  assert.ok(!matchesStarter(starter, "kubernetes"));
});

test("prefs transitions are pure and total", () => {
  let state = togglePinned(prefs(), "builtin:debug");
  assert.deepEqual(state.pinned, ["builtin:debug"]);
  state = togglePinned(state, "builtin:debug");
  assert.deepEqual(state.pinned, []);

  state = setHidden(prefs({ pinned: ["builtin:debug"] }), "builtin:debug", true);
  assert.deepEqual(state, { pinned: [], hidden: ["builtin:debug"], recents: [], custom: [] });
  assert.deepEqual(setHidden(state, "builtin:debug", false).hidden, []);

  state = prefs();
  for (let i = 0; i < STARTER_RECENTS_MAX + 4; i++) state = recordStarterUse(state, `builtin:${i}`);
  assert.equal(state.recents.length, STARTER_RECENTS_MAX);
  assert.equal(state.recents[0], `builtin:${STARTER_RECENTS_MAX + 3}`);
  assert.equal(recordStarterUse(state, state.recents[2]!).recents[0], state.recents[2]);

  const ordered = reorderPinned(prefs({ pinned: ["a", "b", "c"] }), "c", "a");
  assert.deepEqual(ordered.pinned, ["c", "a", "b"]);
  assert.deepEqual(reorderPinned(ordered, "zz", "a").pinned, ["c", "a", "b"], "unknown ids are a no-op");
});

test("custom starters round-trip and delete cleanly", () => {
  const custom = { id: "custom:1", label: "Ship it", prompt: "Ship the branch", icon: "check" as const };
  const saved = withCustomStarter(prefs({ pinned: ["custom:1"], recents: ["custom:1"] }), custom);
  assert.deepEqual(saved.custom, [custom]);
  const parsed = parseStarterPrefs(serializeStarterPrefs(saved));
  assert.deepEqual(parsed, saved);
  const removed = withoutCustomStarter(saved, "custom:1");
  assert.deepEqual(removed.custom, []);
  assert.deepEqual(removed.pinned, []);
  assert.deepEqual(removed.recents, []);
});

test("corrupt or hostile stored prefs degrade to defaults", () => {
  assert.deepEqual(parseStarterPrefs(null), { pinned: [], hidden: [], recents: [], custom: [] });
  assert.deepEqual(parseStarterPrefs("{not json"), { pinned: [], hidden: [], recents: [], custom: [] });
  const parsed = parseStarterPrefs(JSON.stringify({
    pinned: ["a", "a", 7],
    custom: [{ id: "custom:x", label: "x", prompt: "p", icon: "not-an-icon" }, { nope: true }],
  }));
  assert.deepEqual(parsed.pinned, ["a"]);
  assert.equal(parsed.custom.length, 1);
  assert.equal(parsed.custom[0]?.icon, "bookmark");
});

test("model favorites reorder only inside an explicit edit", () => {
  const base = { ...defaultModelPrefs(), favorites: ["a/1", "b/2", "c/3"] };
  assert.deepEqual(reorderFavorite(base, "c/3", "a/1").favorites, ["c/3", "a/1", "b/2"]);
  assert.deepEqual(reorderFavorite(base, "c/3", "c/3").favorites, base.favorites);
  assert.deepEqual(reorderFavorite(base, "zz/9", "a/1").favorites, base.favorites);
});

test("model metadata reads as one ordered line, with acronyms spelled right", async () => {
  const { modelModalityLabels, modelMetaLine } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const model = {
    providerID: "p", modelID: "m", name: "M",
    capabilities: ["input:pdf", "input:image", "output:text", "input:text", "toolcall"],
    context: 500_000,
  };
  assert.deepEqual(modelModalityLabels(model), ["Text", "Image", "PDF"]);
  assert.equal(modelMetaLine(model), "Text · Image · PDF · 500K");
  assert.equal(modelMetaLine({ providerID: "p", modelID: "m", name: "M" }), "Text");
  assert.equal(modelMetaLine({ providerID: "p", modelID: "m", name: "M", context: 2_000_000 }), "Text · 2M");
  assert.equal(modelMetaLine(undefined), "");
});

// ---- viewport + overlay contracts -------------------------------------------

test("visual-viewport geometry is published as CSS variables and started at boot", async () => {
  const viewport = await read("../src/mobileViewport.ts");
  for (const variable of ["--visual-vh", "--visual-bottom", "--keyboard-inset", "--visual-offset"]) {
    assert.ok(viewport.includes(variable), `${variable} is published`);
  }
  assert.ok(viewport.includes("window.visualViewport"), "measurement reads the visual viewport");
  assert.ok(viewport.includes('dataset.keyboard = next.covering ? "open" : "closed"'), "CSS can see the keyboard state");
  assert.ok(viewport.includes("SHORT_VISUAL_BAND"), "CSS can see a band too short for both zones");
  assert.ok(!/localStorage|sessionStorage/.test(viewport), "viewport geometry is never persisted");
  const main = await read("../src/main.tsx");
  assert.ok(main.includes("startMobileViewport()"), "the seam is installed before first paint");
});

test("the mobile viewport allows zoom and requests keyboard content resizing", async () => {
  const html = await read("../src/index.html");
  assert.doesNotMatch(html, /maximum-scale/, "pinch zoom remains available");
  assert.doesNotMatch(html, /user-scalable/, "browser zoom is not disabled");
  assert.match(html, /interactive-widget=resizes-content/, "supporting browsers resize content for the keyboard");
});

test("every redesigned overlay uses the one sheet system", async () => {
  const sheet = await read("../src/components/mobile/Sheet.tsx");
  assert.ok(sheet.includes("useModalSurface"), "sheets share the focus contract");
  assert.ok(!/autoFocus/.test(sheet), "§25: opening a sheet never summons the keyboard");
  assert.ok(sheet.includes('data-sheet-focus'), "focus starts on the sheet, not the search field");
  assert.ok(sheet.includes('type="search"'), "the search row is a real search input");
  assert.ok(sheet.includes("SHEET_DISMISS_DISTANCE"), "swipe-to-dismiss is part of the shared model");

  for (const [name, rel] of [
    ["model picker", "../../../packages/models/widgets/ModelPicker.tsx"],
    ["starter picker", "../src/components/mobile/StarterPicker.tsx"],
    ["project/branch bar", "../src/components/mobile/SessionContextBar.tsx"],
    ["agent/mode picker", "../src/components/Picker.tsx"],
  ] as const) {
    const src = await read(rel);
    assert.match(
      src,
      /from "(?:[^"]*\/)?(?:mobile\/)?Sheet\.tsx"/,
      `${name} renders the shared sheet`,
    );
  }
});

test("a sheet opens on pointer-down and survives the keyboard dismissal (§22)", async () => {
  // The bug this pins: pointer-down dismisses the keyboard, the reflow moves
  // the control out from under the finger, and the click — which used to be
  // what opened the sheet — is delivered to nothing. "The keyboard just
  // closes and no picker opens."
  const trigger = await read("../src/components/mobile/sheetTrigger.ts");
  assert.ok(trigger.includes("onPointerDown"), "touch activates on pointer-down");
  assert.ok(trigger.includes("POINTER_ACTIVATION_WINDOW"), "the echo click is ignored by time, not by a one-shot flag");
  assert.ok(trigger.includes("event.isPrimary"), "secondary and extra pointers are ignored");
  assert.ok(trigger.includes("activate();"), "keyboard activation still arrives as a click");

  for (const [rel, name] of [
    ["../../../packages/models/widgets/ModelPicker.tsx", "model"],
    ["../src/components/Picker.tsx", "mode/thinking"],
    ["../src/components/mobile/SessionContextBar.tsx", "project/branch"],
    ["../src/components/Header.tsx", "session menu"],
    ["../src/components/workspace/builtinSurfaces.tsx", "starter"],
  ] as const) {
    const src = await read(rel);
    assert.ok(src.includes("useSheetTrigger("), `the ${name} trigger uses the shared activation`);
    assert.ok(!/dismissKeyboard\(\)\.then/.test(src), `the ${name} sheet never waits on the keyboard to open`);
  }
});

test("sheets escape their ancestors: portal, top-most Escape, contained focus", async () => {
  const sheet = await read("../src/components/mobile/Sheet.tsx");
  // A `position: fixed` sheet rendered inside the docked composer was captured
  // by that composer's backdrop-filter containing block — it opened into a
  // 60px strip and looked like nothing happened.
  assert.ok(sheet.includes("createPortal(surface, document.body)"), "sheets render at the document root");
  assert.ok(sheet.includes("containing block"), "the reason is recorded next to the portal");
  assert.match(
    sheet,
    /sheets\[sheets\.length - 1\] !== panelRef\.current\?\.parentElement/,
    "Escape closes only the top-most sheet, wherever focus is",
  );
  assert.ok(sheet.includes('closest("button, a, input, textarea, select, [tabindex]")'), "focus stays inside the sheet");
  // Opening on pointer-down means the gesture's own click lands on the sheet
  // that just appeared under the finger — a row directly below the trigger
  // would be picked instantly.
  assert.ok(sheet.includes("onPointerDownCapture"), "the sheet tracks presses that start inside it");
  assert.match(
    sheet,
    /event\.detail > 0 && !pointerInside\.current[\s\S]*?event\.preventDefault\(\)/,
    "a pointer click with no press inside the sheet is the opening gesture's ghost, and is swallowed",
  );
  assert.ok(sheet.includes("event.detail > 0"), "keyboard-generated clicks are never swallowed");

  const composer = await read("../src/components/Composer.tsx");
  assert.ok(
    composer.includes('target?.closest?.(".sheet-backdrop")'),
    "a press inside a portalled sheet is still composer interaction",
  );
});

test("the composer is adaptive, with one primary action at a time", async () => {
  const composer = await read("../src/components/Composer.tsx");
  assert.ok(composer.includes("composer-collapsed"), "an idle phone composer is compact");
  assert.ok(composer.includes("composer-expanded"), "focus expands it");
  assert.ok(composer.includes("composer-has-draft"), "the draft state drives the mic/send morph");
  assert.ok(
    composer.includes("inputFocused || hasDraft || working || shellMode"),
    "text, attachments, and active runs all count as in use",
  );
  assert.ok(composer.includes("useViewportMetrics().height"), "auto-grow reacts to the visible viewport");
  assert.ok(
    composer.includes("Math.max(44, Math.min(visible * 0.42, visible - 240))"),
    "the input never grows past the room its own chrome needs",
  );
  assert.ok(!composer.includes("STARTER_SUGGESTIONS"), "starters come from the starter system, not hardcoded chips");
  assert.ok(composer.includes("mobileSheet"), "the mode selector opens as a sheet on phones");
});

test("reasoning effort stays reachable on phones, beside the model name", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const header = composer.slice(composer.indexOf('<div className="composer-model-header">'));
  const clusterStart = header.indexOf('<span className="composer-mode-cluster">');
  const cluster = header.slice(clusterStart, header.indexOf("</span>\n        </div>", clusterStart));
  assert.ok(cluster.includes("composer-thinking-badge"), "§59: the thinking control lives in the model header");
  assert.ok(
    cluster.indexOf("composer-thinking-badge") < cluster.indexOf("composer-agent-badge"),
    "thinking sits between the model name and the mode chip",
  );
  assert.ok(cluster.includes("modelSupportsThinking(selectedModel)"), "it only exists for models that report variants");
  assert.ok(cluster.includes("<ThinkingSlider"), "thinking uses a discrete slider, not a picker");
  assert.ok(cluster.includes("pickThinking(thinking || undefined)"), "slider saves the effort and updates the composer config");
  assert.ok(composer.includes("const THINKING_LABELS"), "backend variant strings get display labels");

  // A tap on any header control blurs the input; collapsing on that blur would
  // unmount the control before its click lands (the tap would be swallowed).
  assert.ok(
    composer.includes("if (focused) setInputFocused(true);"),
    "blur alone never collapses the composer",
  );
  assert.ok(
    composer.includes("if (rootRef.current?.contains(target)) return;")
    && composer.includes("setInputFocused(false);"),
    "engagement ends on a pointer press outside the composer",
  );

  const css = await readWebStyles();
  const section = css.slice(css.indexOf("UX-MOBILE-01 — mobile-first new chat"));
  const at = section.search(/\.composer-mobile \.composer-agent-badge,\s*\n\s*\.composer-mobile \.composer-thinking-badge/);
  assert.ok(at > 0, "the thinking control shares the mode chip's touch box");
  assert.match(section.slice(at, section.indexOf("}", at)), /var\(--tap\)/);
});

test("phone CSS keeps the layout inside the visible viewport", async () => {
  const css = await readWebStyles();
  const start = css.indexOf("UX-MOBILE-01 — mobile-first new chat");
  assert.ok(start > 0, "the redesign section exists");
  const section = css.slice(start);
  const phone = section.slice(section.indexOf("@media (max-width: 480px)"));

  assert.match(phone, /\.app,\n\s+\.app\.mode-chat\.view-session \{\n\s+height: var\(--visual-bottom, 100dvh\);/, "the shell bottom tracks the visible viewport");
  assert.ok(phone.includes("--visual-bottom includes that offset"), "Safari's visual-viewport pan is included once, in the shell height");
  assert.match(phone, /overflow-x: hidden/, "§33: no horizontal scrolling");
  assert.match(phone, /input, textarea, select \{ font-size: max\(16px, 1em\); \}/, "§32: no Safari auto-zoom");
  assert.match(phone, /touch-action: manipulation/, "§28: no accidental double-tap zoom on controls");
  assert.match(phone, /body\[data-keyboard="open"\]/, "§43: the empty state yields to the keyboard");
  assert.match(phone, /body\[data-band="short"\] \.hero-body \{ display: none; \}/, "a short band drops the empty state entirely");
  assert.match(phone, /composer-mobile:not\(\.composer-has-draft\) \.composer-primary \.send \{ display: none; \}/);
  assert.match(phone, /composer-mobile\.composer-has-draft \.composer-mobile-extensions \.mic-btn\s*\{\s*display:\s*none;/);
  assert.match(
    phone,
    /composer-mobile\.composer-collapsed:not\(\.composer-has-draft\) \.composer-workflow\s*\{\s*display:\s*none;/,
    "only an empty resting composer may hide the workflow action",
  );
  assert.match(
    phone,
    /composer-mobile\.composer-has-draft \.composer-workflow\s*\{\s*display:\s*inline-flex;/,
    "a draft keeps Run workflow visible during narrow-layout transitions",
  );
  assert.match(phone, /max-height: 42dvh/, "§20: the input stops growing and scrolls");
  assert.match(section, /margin-bottom: var\(--keyboard-inset, 0px\)/, "§21: sheets sit above the keyboard");
  assert.match(section, /max-height: calc\(var\(--visual-vh, 100dvh\)/, "§29: sheets are sized by the visible band");
  assert.match(section, /html\[data-sheet="open"\], html\[data-sheet="open"\] body \{ overflow: hidden; \}/);
  assert.ok(!/100vh/.test(phone), "the phone layout never trusts the layout viewport height");
});

test("touch targets and design tokens are centralized", async () => {
  const css = await readWebStyles();
  const tokens = css.slice(0, css.indexOf("/* F15: syntax roles"));
  for (const token of [
    "--space-4: 16px", "--tap: 44px", "--radius-sheet: 24px",
    "--font-input: 16px", "--safe-left: env(safe-area-inset-left, 0px)",
    "--safe-right: env(safe-area-inset-right, 0px)",
    "--safe-bottom: env(safe-area-inset-bottom, 0px)",
  ]) {
    assert.ok(tokens.includes(token), `${token} is a shared token`);
  }
  const section = css.slice(css.indexOf("UX-MOBILE-01 — mobile-first new chat"));
  // Repeated controls size themselves from --tap rather than ad-hoc pixels.
  for (const selector of [".starter-chip", ".context-trigger", ".model-trigger-mobile", ".sheet-row-star"]) {
    const at = section.search(new RegExp(`\\${selector}\\s*[,{]`));
    assert.ok(at > 0, `${selector} is styled in the redesign section`);
    const rule = section.slice(at, section.indexOf("}", at));
    assert.match(rule, /var\(--tap\)/, `${selector} is at least one tap target tall`);
  }
});

test("the phone shell restores session navigation below a swipeable shortcut rail", async () => {
  const header = await read("../src/components/Header.tsx");
  const bottom = await read("../src/components/workspace/WorkspaceBottomNav.tsx");
  const navigation = await read("../src/components/mobile/MobileNavigationRail.tsx");
  const css = await readWebStyles();

  assert.ok(header.includes("<MobileNavigationRail />"), "the phone header is the shortcut rail");
  assert.equal(header.match(/<WorkspaceBottomNav \/>/g)?.length, 2, "phone and tablet shells mount the session bar");
  assert.doesNotMatch(bottom, />Recents</, "the Recents action is icon-only");
  assert.doesNotMatch(bottom, />New chat</, "the New chat action is icon-only");
  assert.ok(bottom.includes("workspace.workspacebottomnav.sessionHistory"), "Recents keeps an accessible name");
  assert.ok(bottom.includes("workspace.workspacebottomnav.newSession"), "New chat keeps an accessible name");
  assert.ok(bottom.includes("Projects &amp; sessions"), "the title button identifies the projects and sessions drawer");
  assert.ok(bottom.includes("displaySessionTitle"), "the projects and sessions button shows the current session title");
  assert.match(css, /\.workspace-bottom-nav\s*\{\s*position:\s*fixed;/, "the session bar is fixed to the compact shell bottom");
  assert.match(css, /\.mobile-shortcut-rail\s*\{[^}]*overflow-x:\s*auto;/s, "extra top icons reveal with horizontal swipe");
  assert.match(css, /\.mobile-shortcut\s*\{[^}]*var\(--tap\)/s, "every shortcut keeps a 44px touch target");
  assert.ok(navigation.includes("useResolvedCapabilities()"), "the rail follows configured capabilities");
  assert.ok(navigation.includes("useRailSurfaceModel()"), "notification and plugin surfaces stay reachable");
  assert.ok(navigation.includes("ui.mobileShortcuts"), "the rail follows the ordered Settings preference");
  assert.doesNotMatch(navigation, /mobile-navigation-grid|header\.application/, "the grouped Application menu is gone");
});

test("haptics are opt-in, bounded, and respect reduced motion", async () => {
  const haptics = await read("../src/haptics.ts");
  assert.ok(haptics.includes('matchMedia("(prefers-reduced-motion: reduce)")'), "reduced motion silences it");
  assert.ok(haptics.includes("typeof navigator.vibrate !== \"function\""), "unsupported platforms are a no-op");
  for (const rel of [
    "../../../packages/models/widgets/ModelPicker.tsx",
    "../src/components/Picker.tsx",
    "../src/components/workspace/builtinSurfaces.tsx",
  ]) {
    assert.ok((await read(rel)).includes("tapFeedback("), `${rel} confirms its touch selection`);
  }
});

test("the fresh-session screen is three zones with a sticky interaction dock", async () => {
  const surface = await read("../src/components/workspace/builtinSurfaces.tsx");
  const composer = await read("../src/components/Composer.tsx");
  assert.ok(surface.includes('className="stage stage-new"'));
  assert.ok(surface.includes('className="hero-body"'), "empty state and starters scroll together");
  assert.ok(surface.includes('className="hero-dock"'), "context bar and composer share the sticky zone");
  assert.ok(composer.includes("<SessionContextBar {...contextBar} />"), "project and branch live inside every composer");
  assert.ok(!surface.includes("SessionContextBar"), "the fresh surface cannot fork composer controls");
  assert.ok(!surface.includes("new-session-targets"), "the full-width mid-page selectors are gone");
  assert.ok(!surface.includes("hero-mark"), "the decorative mark no longer competes with the headline");
  assert.ok(surface.includes("visibleStarters"), "chips come from the starter system");
  assert.ok(surface.includes('slot="session.empty.widgets"'), "idle content is a widget slot, not hero hardcode");
  assert.ok(surface.includes('registerSlot("session.empty.widgets", "builtin.hero-starters"'), "starters register as a widget");
  assert.ok(surface.includes('registerSlot("session.empty.widgets", "builtin.hero-recent"'), "recents register as a widget");

  const css = await readWebStyles();
  const section = css.slice(css.indexOf("UX-MOBILE-01 — mobile-first new chat"));
  const dock = section.slice(section.indexOf(".hero-dock {"));
  assert.match(dock.slice(0, dock.indexOf("}")), /var\(--safe-bottom\)/, "§30: the dock respects the home indicator");
});

test("fresh-chat widgets persist visibility and order, and remain replaceable", async () => {
  const contract = await read("../../../packages/contracts/src/index.ts");
  const widget = await read("../src/components/mobile/HeroWidgets.tsx");
  const surface = await read("../src/components/workspace/builtinSurfaces.tsx");
  assert.ok(contract.includes('"session.empty.widgets"'), "the widget seam is normative");
  assert.ok(widget.includes('const KEY = "polyth.heroWidgets.v1"'), "preferences are persisted");
  assert.ok(widget.includes("hidden: HeroWidgetId[]"), "widgets may be hidden");
  assert.ok(widget.includes("order: HeroWidgetId[]"), "widgets may be reordered");
  assert.ok(widget.includes("HeroWidgetSettings"), "the user gets a compact customization sheet");
  assert.ok(surface.includes("Plugins can register another `session.empty.widgets` contribution"), "plugins can add/replacement widgets");
});
