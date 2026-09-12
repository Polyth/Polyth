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
  starterPrefsStorageKey,
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
  ({ shared: false, pinned: [], hidden: [], recents: [], custom: [], ...patch });

// ---- visual viewport geometry ----------------------------------------------

test("the keyboard inset is the strip of the layout viewport it covers", () => {
  // 932pt layout, 596pt visible, page not scrolled → 336pt of keyboard.
  assert.equal(keyboardInsetFrom(932, 596, 0), 336);
  // Visual viewport pushed down (pinch/scroll) counts against the strip.
  assert.equal(keyboardInsetFrom(932, 596, 36), 300);
});

test("a native keyboard inset remains observable without visualViewport", () => {
  // Capacitor can report the keyboard while an embedded WebView has no
  // visualViewport API. The layout height is then its only browser geometry.
  assert.deepEqual(
    metricsFrom(932, 932, 0, 336),
    { height: 932, keyboardInset: 336, offsetTop: 0, covering: true },
  );
});

test("background composer updates do not steal the active editor focus", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const insertHandler = composer.match(/const handler = \(e: Event\) => \{[\s\S]*?\n    \};/)?.[0] ?? "";
  assert.ok(insertHandler.includes("insert(detail);"), "composer insert events still update the draft");
  assert.doesNotMatch(insertHandler, /inputRef\.current\?\.focus\(\)/,
    "dictation and other background inserts leave focus with the active editor");
});

test("late dictation finals remain owned by their originating composer", async () => {
  const voice = await read("../../../packages/dictation/widgets/voice.tsx");
  const stop = voice.slice(voice.indexOf("const stop = () =>"), voice.indexOf("const startBrowser ="));

  assert.match(stop, /const generation = startGeneration\.current/);
  assert.match(stop, /const originScope = originScopeRef\.current/);
  assert.match(stop, /composerScopeKey\(\) !== originScope/);
  assert.ok(stop.indexOf("streamRef.current = null") > stop.indexOf(".then((text)"),
    "the stream remains cancellable until finalization settles");
  assert.ok(stop.indexOf("requestComposerInsert") > stop.indexOf("composerScopeKey() !== originScope"),
    "insertion happens only after generation and composer-scope checks");
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
  assert.deepEqual(state, { shared: false, pinned: [], hidden: ["builtin:debug"], recents: [], custom: [] });
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
  assert.deepEqual(parseStarterPrefs(null), { shared: false, pinned: [], hidden: [], recents: [], custom: [] });
  assert.deepEqual(parseStarterPrefs("{not json"), { shared: false, pinned: [], hidden: [], recents: [], custom: [] });
  const parsed = parseStarterPrefs(JSON.stringify({
    pinned: ["a", "a", 7],
    custom: [{ id: "custom:x", label: "x", prompt: "p", icon: "not-an-icon" }, { nope: true }],
  }));
  assert.deepEqual(parsed.pinned, ["a"]);
  assert.equal(parsed.custom.length, 1);
  assert.equal(parsed.custom[0]?.icon, "bookmark");
});

test("starter prefs default to project scope and expose the shared picker control", async () => {
  assert.equal(starterPrefsStorageKey("project-a"), "polyth.starters.v1.project-a");
  assert.equal(parseStarterPrefs(JSON.stringify({ shared: true })).shared, true);
  assert.equal(parseStarterPrefs(JSON.stringify({ shared: "yes" })).shared, false);

  const picker = await read("../src/components/mobile/StarterPicker.tsx");
  assert.ok(picker.includes("setStarterShared"), "the picker can change preference scope");
  assert.ok(picker.includes('tr("mobile.starterpicker.shareAcrossProjects")'), "the shared control is translated");
});

test("model favorites reorder only inside an explicit edit", () => {
  const base = { ...defaultModelPrefs(), favorites: ["a/1", "b/2", "c/3"] };
  assert.deepEqual(reorderFavorite(base, "c/3", "a/1").favorites, ["c/3", "a/1", "b/2"]);
  assert.deepEqual(reorderFavorite(base, "c/3", "c/3").favorites, base.favorites);
  assert.deepEqual(reorderFavorite(base, "zz/9", "a/1").favorites, base.favorites);
});

test("model metadata reads as one ordered line, with acronyms spelled right", async () => {
  const { modelModalityLabels, modelMetaLine } = await import("@polyth/models/model-presentation");
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
  const bootstrap = await read("../src/bootstrap.tsx");
  assert.ok(bootstrap.includes("startMobileViewport()"), "the seam is installed before first paint");
});

test("the mobile viewport is fixed and requests keyboard content resizing", async () => {
  const html = await read("../src/index.html");
  assert.match(html, /maximum-scale=1/, "pinch zoom is disabled");
  assert.match(html, /user-scalable=no/, "the browser cannot pan a zoomed chat sideways");
  assert.match(html, /interactive-widget=resizes-content/, "supporting browsers resize content for the keyboard");
});

test("every redesigned overlay uses the one sheet system", async () => {
  const [sheet, dialog] = await Promise.all([
    read("../src/components/mobile/Sheet.tsx"),
    read("../src/components/a11y/Dialog.tsx"),
  ]);
  assert.ok(sheet.includes("useModalSurface"), "sheets share the focus contract");
  assert.ok(!/autoFocus/.test(sheet), "§25: opening a sheet never summons the keyboard");
  assert.ok(sheet.includes('data-sheet-focus'), "focus starts on the sheet, not the search field");
  assert.ok(sheet.includes('type="search"'), "the search row is a real search input");
  assert.ok(sheet.includes("SHEET_DISMISS_DISTANCE"), "swipe-to-dismiss is part of the shared model");
  assert.ok(dialog.includes("el.matches(initialFocus)"), "the modal contract can focus the sheet panel itself");
  assert.ok(dialog.includes("focusFrames >= 20"), "opening focus is guarded across multiple animation frames");
  assert.ok(dialog.includes("guardOpeningFocus();"), "focus monitoring continues after the first successful frame");

  for (const [name, rel] of [
    ["model picker", "../../../packages/models/widgets/ModelPicker.tsx"],
    ["starter picker", "../src/components/mobile/StarterPicker.tsx"],
    ["project/branch bar", "../src/components/mobile/SessionContextBar.tsx"],
    ["agent/mode picker", "../src/components/Picker.tsx"],
  ] as const) {
    const src = await read(rel);
    assert.match(
      src,
      /(?:from "(?:[^"]*\/)?(?:mobile\/)?Sheet\.tsx"|ResponsiveOverlay)/,
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
  assert.ok(trigger.includes("event.currentTarget.focus"), "the modal records the pointer trigger as its opener");
  assert.ok(trigger.includes("activate();"), "keyboard activation still arrives as a click");

  for (const [rel, name] of [
    ["../../../packages/models/widgets/ModelPicker.tsx", "model"],
    ["../src/components/Picker.tsx", "mode/thinking"],
    ["../src/components/mobile/SessionContextBar.tsx", "project/branch"],
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
  assert.ok(composer.includes("composer-input-active"), "textarea focus is exposed for keyboard-safe shell CSS");
  assert.ok(composer.includes("composer-has-draft"), "the draft state drives the mic/send morph");
  assert.ok(
    composer.includes("const expanded = !phoneLayout || inputFocused || shellMode"),
    "focus and shell mode expand the phone composer; a working turn alone keeps it minified (Stop stays in the collapsed row)",
  );
  assert.ok(composer.includes('hasDraft ? " composer-has-draft" : ""'),
    "text and attachments retain their independent draft state");
  assert.ok(composer.includes("useViewportMetrics().height"), "auto-grow reacts to the visible viewport");
  assert.ok(
    composer.includes("Math.max(44, Math.min(visible * 0.42, visible - 240))"),
    "the input never grows past the room its own chrome needs",
  );
  assert.ok(
    composer.includes("Math.max(44, visible * 0.42)"),
    "wider layouts keep the plain proportional cap",
  );
  assert.ok(!composer.includes("STARTER_SUGGESTIONS"), "starters come from the starter system, not hardcoded chips");
  const modelPicker = await read("../../../packages/models/widgets/ModelPicker.tsx");
  assert.match(modelPicker, /<ResponsiveOverlay[\s\S]*className=\{phone \? "model-sheet"/, "phone model and harness controls use the shared sheet");
  assert.ok(
    composer.includes('onClick={() => send()}'),
    "the primary active-run action retains the configured queue behavior",
  );
  assert.ok(
    composer.includes('onSelect: () => send(undefined, "interrupt")'),
    "Send now remains an explicit interrupt action in the active-run menu",
  );
  assert.ok(
    composer.includes('api.queueSendNow(target, editing.id, t)'),
    "Send now applies an edited queued message immediately",
  );

  const css = await readWebStyles();
  assert.match(
    css,
    /\.composer-mobile\.composer-expanded \.composer-card textarea\s*\{\s*min-height:\s*calc\(var\(--tap\) \* 2\);/s,
    "an active composer opens into a usable writing area",
  );
  assert.match(
    css,
    /\.composer-mobile \.composer-card,\s*\.composer-mobile \.composer-card:focus-within\s*\{\s*box-shadow:\s*none;/s,
    "the mobile input remains shadow-free while focused",
  );
  assert.match(
    css,
    /\.composer-card textarea:focus-visible \{ outline: none; box-shadow: none; \}/,
    "the textarea itself cannot reintroduce the global focus shadow",
  );
  assert.match(
    css,
    /\.composer-mobile\.composer-collapsed \.composer-leading-zone\s*\{\s*display:\s*contents;/,
    "collapsed composer actions participate in the single resting row",
  );
  assert.match(
    css,
    /\.composer-mobile\.composer-collapsed \.composer-actions > :is\(\.composer-extensions, \.composer-next-action\)\s*\{\s*display:\s*none;/,
    "trailing controls stay out of the collapsed phone composer",
  );
});

test("phone execution controls live behind the model picker with harness tabs", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const harnessPicker = await read("../../../packages/harness-runtime/widgets/runtime.tsx");
  const modelPicker = await read("../../../packages/models/widgets/ModelPicker.tsx");
  const modelStyles = await read("../../../packages/models/widgets/styles.css");
  const effortMenu = await read("../src/components/EffortMenu.tsx");
  const miniWidgets = await read("../src/widgets/builtinMiniWidgets.tsx");
  const styles = await read("../src/styles.css");

  // Phones expose the model trigger; its sheet owns harness tabs plus thinking
  // controls. Desktop keeps the same model control in the rail.
  assert.ok(!composer.includes('className="composer-config-top"'), "phones do not stack a second configuration row above the editor");
  assert.ok(composer.includes("{!phoneLayout && modelControl}"), "the desktop rail keeps the model control");
  assert.ok(composer.includes("{phoneLayout && modelControl}"), "the collapsed phone rail keeps the model trigger available");
  assert.ok(composer.includes('slot="modelPicker.header"'), "the model picker mounts the package header seam");
  assert.ok(modelPicker.includes('className="model-picker-header"'), "the model picker renders contributed routing above its catalog");
  assert.ok(harnessPicker.includes('slot: "modelPicker.header"'), "the harness package contributes to the model picker");
  assert.ok(harnessPicker.includes("<Tabs tabs={tabs}"), "harness choices use the shared accessible tabs primitive");
  assert.ok(!harnessPicker.includes("pkg-harnesses-manage"), "the picker header does not expose harness Manage");
  assert.ok(!harnessPicker.includes('id: "auto"'), "the picker header does not expose an Auto harness tab");
  assert.ok(!harnessPicker.includes("pkg-harnesses-trigger"), "there is no separate harness picker trigger");
  assert.ok(modelPicker.includes("AdjacentDetailsPanel"), "model details render in an adjacent panel");
  assert.ok(!modelPicker.includes("{detail ? detailsView"), "the picker shell never swaps to an in-overlay details page");
  assert.ok(!composer.includes("executionAgentControl"), "agent choices are not passed into the composer");
  assert.ok(!harnessPicker.includes("agentControl"), "the model sheet does not render agent choices");
  assert.ok(harnessPicker.includes('aria-label="Execution settings"'), "the model sheet groups execution controls accessibly");
  assert.match(modelStyles, /\.model-picker-trigger\s*\{[^}]*var\(--hit-min\)/s, "the phone model trigger keeps a coarse-pointer hit target");
  assert.ok(composer.includes("const effortControl"), "composer derives one effort control");
  assert.ok(composer.includes("modelSupportsThinking(selectedModel)"), "it only exists for models that report variants");
  assert.ok(composer.includes("cfg.thinking !== undefined"), "Auto suppresses saved and session thinking fallbacks");
  assert.ok(composer.includes("onCommit={preserveKeyboard}"), "the keyboard reopens once the drag ends");
  assert.ok(composer.includes("pickThinking(thinking || undefined)"), "picking saves the effort and updates the composer config");
  assert.ok(composer.includes("composerEffortControl: phoneLayout ? null : effortControl"), "desktop slots own the rendered effort control");
  assert.ok(miniWidgets.includes('id: "composer.effort"'), "effort is registered in the shared widget layout");
  assert.ok(effortMenu.includes('type="range"'), "effort uses a direct discrete slider on every layout");
  assert.ok(!effortMenu.includes("<select"), "the phone select variant is gone — dragging works on touch");
  assert.ok(effortMenu.includes('const options = ["", ...new Set(variants)]'), "Auto and each backend variant get a fixed stop");
  assert.ok(effortMenu.includes("thinkingVariantLabel"), "backend variant strings get display labels");
  assert.ok(effortMenu.includes("{adjusting && ("), "the selected effort appears only while adjusting the slider");
  assert.ok(effortMenu.includes("aria-valuetext={label}"), "the selected effort remains available to assistive technology");
  assert.ok(styles.includes("background: var(--border-soft);"), "the effort track remains neutral");

  // A tap on any rail control blurs the input; collapsing on that blur would
  // unmount the control before its click lands (the tap would be swallowed).
  assert.ok(
    composer.includes("if (focused) setInputFocused(true);"),
    "blur alone never collapses the composer",
  );
  assert.ok(
    composer.includes('document.addEventListener("click", onClick)')
    && composer.includes("if (rootRef.current?.contains(target)) return;")
    && composer.includes("setInputFocused(false);"),
    "engagement ends after an outside click reaches its target",
  );

  const css = await readWebStyles();
  const section = css.slice(css.indexOf("UX-MOBILE-01 — mobile-first new chat"));
  const harnessStyles = await read("../../../packages/harness-runtime/widgets/styles.css");
  assert.match(
    harnessStyles,
    /\.pkg-harnesses-mobile-config > div \{[^}]*grid-template-columns:/s,
    "the execution sheet aligns its labelled controls without a horizontal rail",
  );
  const at = section.search(/\.composer-mobile \.composer-config \.config-chip,\s*\n\s*\.composer-mobile \.composer-config \.picker-chip/);
  assert.ok(at > 0, "every config chip shares the same touch box");
  assert.match(section.slice(at, section.indexOf("}", at)), /var\(--tap\)/);
});

test("phone CSS keeps the layout inside the visible viewport", async () => {
  const css = await readWebStyles();
  const start = css.indexOf("UX-MOBILE-01 — mobile-first new chat");
  assert.ok(start > 0, "the redesign section exists");
  const section = css.slice(start);
  const phone = section.slice(section.indexOf("@media (max-width: 480px)"));

  assert.match(
    css,
    /\.app\.mode-chat\.view-session \{[^}]*min-height:\s*100dvh/,
    "the phone shell fills the dynamic viewport while keyboard-open composition owns its inset",
  );
  assert.doesNotMatch(css, /body\[data-keyboard="open"\][\s\S]{0,180}\.composer-chat\.composer-mobile\s*\{[^}]*position:\s*fixed/s,
    "the composer keeps the visualViewport flow contract instead of switching positioning modes");
  assert.match(phone, /overflow-x: hidden/, "§33: no horizontal scrolling");
  assert.match(phone, /input, textarea, select \{ font-size: max\(16px, 1em\); \}/, "§32: no Safari auto-zoom");
  assert.match(phone, /touch-action: manipulation/, "§28: no accidental double-tap zoom on controls");
  assert.match(phone, /body\[data-keyboard="open"\]/, "§43: the empty state yields to the keyboard");
  assert.match(phone, /body\[data-band="short"\] \.hero-body \{ display: none; \}/, "a short band drops the empty state entirely");
  assert.match(phone, /composer-mobile:not\(\.composer-has-draft\) \.composer-primary \.send \{ display: none; \}/);
  assert.match(phone, /composer-mobile\.composer-has-draft \.composer-mobile-extensions \.mic-btn\s*\{\s*display:\s*none;/);
  assert.match(
    phone,
    /\.composer-mobile \.composer-mobile-extensions \{[^}]*max-width:\s*var\(--tap\);[^}]*overflow-x:\s*auto;/s,
    "optional actions scroll inside one touch-width instead of covering model controls",
  );
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
  // The font-scaled token sets the normal ceiling; the viewport share keeps a
  // short band from handing the input the whole screen.
  assert.match(
    phone,
    /max-height: min\(var\(--composer-max-input-height\), 18dvh\)/,
    "§20: the expanded phone input stays compact and scrolls",
  );
  const sharedSheet = section.slice(section.indexOf(".sheet {"), section.indexOf("@keyframes sheet-rise"));
  assert.match(sharedSheet, /max-height: calc\(var\(--visual-vh, 100dvh\)/, "§29: sheets are sized by the visible band");
  assert.doesNotMatch(sharedSheet, /(?:height|margin-bottom):[^;]*--keyboard-inset/, "§21: the already-reduced visible band is not subtracted twice");
  assert.match(section, /html\[data-sheet="open"\], html\[data-sheet="open"\] body \{ overflow: hidden; \}/);
  assert.ok(!/100vh/.test(phone), "the phone layout never trusts the layout viewport height");
});

test("touch targets and design tokens are centralized", async () => {
  const css = await readWebStyles();
  const dictationCss = await read("../../../packages/dictation/widgets/styles.css");
  const tokens = css.slice(0, css.indexOf("/* F15: syntax roles"));
  for (const token of [
    "--space-4: 16px", "--tap: 44px",
    "--radius-sheet: calc(16px * var(--corner-radius-scale))",
    "--font-input: var(--ui-font-size, 15px)",
    "--safe-left: var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
    "--safe-right: var(--safe-area-inset-right, env(safe-area-inset-right, 0px))",
    "--safe-bottom: var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
  ]) {
    assert.ok(tokens.includes(token), `${token} is a shared token`);
  }
  const section = css.slice(css.indexOf("UX-MOBILE-01 — mobile-first new chat"));
  // Repeated controls size themselves from --tap rather than ad-hoc pixels.
  for (const selector of [".starter-chip", ".context-trigger", ".config-chip", ".sheet-row-star"]) {
    const at = section.search(new RegExp(`\\${selector}\\s*[,{]`));
    assert.ok(at > 0, `${selector} is styled in the redesign section`);
    const rule = section.slice(at, section.indexOf("}", at));
    assert.match(rule, /var\(--tap\)/, `${selector} is at least one tap target tall`);
  }
  assert.match(
    css,
    /@media \(pointer: coarse\) \{\s*\.composer-simple \.composer-add-trigger \{[^}]*min-width:\s*var\(--tap\);/s,
    "the compact Add control remains a full touch target on coarse pointers",
  );
  assert.match(
    dictationCss,
    /@media \(pointer: coarse\) \{\s*\.mic-control \.mic-btn,[^}]*\{[^}]*min-width:\s*var\(--tap\);[^}]*min-height:\s*var\(--tap\);/s,
    "the compact Dictate control remains a full touch target on coarse pointers",
  );
});

test("phone views expose only floating power-on-demand controls", async () => {
  const header = await read("../src/components/Header.tsx");
  const mobileHeader = await read("../src/components/mobile/MobileSessionHeader.tsx");
  const navigation = await read("../src/components/mobile/MobileNavigationRail.tsx");
  const css = await readWebStyles();

  assert.match(header, /if \(mode === "phone"\) \{\s*return chatSurface \? <MobileSessionHeader \/> : <MobileViewHeader \/>;\s*\}/s, "phone chat uses the session island; other phone views use the view header");
  const phoneBranch = header.slice(header.indexOf('if (mode === "phone")'), header.indexOf("\n\n  return (", header.indexOf('if (mode === "phone")')));
  assert.doesNotMatch(phoneBranch, /MobileNavigationRail/, "the phone branch cannot bring back the legacy rail");
  assert.doesNotMatch(header, /WorkspaceBottomNav/, "active phone chat has no bottom navigation");
  assert.match(mobileHeader, /label="Open navigation"/);
  assert.match(mobileHeader, /label="Open tools"/);
  assert.match(mobileHeader, /label="New session"/);
  assert.match(mobileHeader, /<IslandOverview/);
  assert.match(mobileHeader, /<Tools/);
  assert.doesNotMatch(mobileHeader, /Icon\.plus/);
  assert.match(css, /\.mobile-session-floats\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.mobile-tools-sheet\.sheet\s*\{[^}]*width:\s*calc\(100vw/s);
  // The reserved band clears the floating island: safe area, the island's own
  // height (never below the tap floor), and the chrome inset around it.
  assert.match(
    css,
    /\.app-shell\s*\{[^}]*padding-top:\s*calc\(var\(--safe-top\) \+ var\(--conversation-chrome-inset\) \+ max\(var\(--tap\), var\(--mobile-island-height\)\) \+ var\(--space-4\)\)/s,
    "non-chat phone views clear the floating shell",
  );
  assert.ok(navigation.includes("useResolvedCapabilities()"), "the rail follows configured capabilities");
  assert.ok(navigation.includes("useRailSurfaceModel()"), "notification and plugin surfaces stay reachable");
  assert.ok(navigation.includes("ui.mobileShortcuts"), "the rail follows the ordered Settings preference");
  assert.doesNotMatch(navigation, /mobile-navigation-grid|header\.application/, "the grouped Application menu is gone");
});

test("haptics are bounded local feedback and stay independent from reduced motion", async () => {
  const haptics = await read("../src/haptics.ts");
  assert.ok(haptics.includes("typeof navigator.vibrate !== \"function\""), "unsupported platforms are a no-op");
  assert.doesNotMatch(haptics, /reduceAnimations|prefers-reduced-motion|desktopLowResource/);
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
  assert.ok(surface.includes('className="hero-body customize-zone"'), "empty state and starters scroll together");
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
