import test from "node:test";
import assert from "node:assert/strict";

const stored = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value); },
  removeItem: (key: string) => { stored.delete(key); },
};

stored.set("polyth.settings", JSON.stringify({
  theme: "midnight",
  density: "compact",
  productName: "Legacy name",
  chatWidth: "wide",
}));

const product = await import("../src/settings.ts");
const ui = await import("../src/uiPrefs.ts");

test("legacy mixed settings migrate into independent versioned records", () => {
  const productSettings = product.loadSettings();
  assert.equal(productSettings.productName, "Legacy name");
  assert.equal(productSettings.theme, "midnight");
  assert.equal(productSettings.appearanceMode, "system");
  assert.equal(productSettings.fontFamily, "theme");
  assert.equal(ui.getUiSettings().chatWidth, "wide");

  assert.ok(stored.has(product.SETTINGS_KEY));
  assert.ok(stored.has(ui.UI_SETTINGS_KEY));
  assert.notEqual(product.SETTINGS_KEY, ui.UI_SETTINGS_KEY);
});

test("legacy system theme migrates to an independent system appearance mode", () => {
  const migrated = product.normalizeSettings({ theme: "system" });
  assert.equal(migrated.theme, "midnight");
  assert.equal(migrated.appearanceMode, "system");
});

test("new installations start from the curated appearance; saved records keep theirs", () => {
  assert.deepEqual(
    {
      theme: product.DEFAULT_SETTINGS.theme,
      appearanceMode: product.DEFAULT_SETTINGS.appearanceMode,
      density: product.DEFAULT_SETTINGS.density,
      fontFamily: product.DEFAULT_SETTINGS.fontFamily,
    },
    // macOS 27 colours, light or dark as the operating system says.
    { theme: "liquid-glass", appearanceMode: "system", density: "compact", fontFamily: "theme" },
  );
  assert.deepEqual(product.parseSettings(null), product.DEFAULT_SETTINGS);
  // A saved record without these fields predates the new defaults and keeps
  // the appearance it was saved with.
  const saved = product.normalizeSettings({});
  assert.deepEqual(
    [saved.theme, saved.appearanceMode, saved.density, saved.fontSize, saved.chatFontSize, saved.fontFamily],
    ["midnight", "system", "comfortable", 15, 15, "theme"],
  );
  assert.equal(product.normalizeSettings({ appearanceMode: "light" }).appearanceMode, "light", "a picked mode stays");
});

test("style and accent are their own settings; a saved record keeps its palette's own style", () => {
  assert.equal(product.DEFAULT_SETTINGS.themeStyle, "liquid-glass");
  assert.equal(product.DEFAULT_SETTINGS.accentColor, "");
  // A record saved before style and colours split draws each palette in the
  // style it was authored for until the user picks one.
  const old = product.normalizeSettings({ theme: "fluent", appearanceMode: "dark" });
  assert.equal(old.themeStyle, "auto");
  assert.equal(old.accentColor, "");
  const chosen = product.normalizeSettings({ theme: "midnight", themeStyle: "macos", accentColor: "#A550A7" });
  assert.equal(chosen.themeStyle, "macos");
  assert.equal(chosen.accentColor, "#a550a7");
  for (const themeStyle of ["liquid-glass", "fluent", "macos", "classic", "auto"]) {
    assert.equal(product.normalizeSettings({ themeStyle }).themeStyle, themeStyle);
  }
  const garbage = product.normalizeSettings({ themeStyle: "aqua", accentColor: "red" });
  assert.equal(garbage.themeStyle, "auto");
  assert.equal(garbage.accentColor, "");
  assert.equal(product.normalizeSettings({ accentColor: "#abc" }).accentColor, "", "only #rrggbb is stored");
});

test("interface font catalog accepts curated fonts, migrates legacy ids, and rejects unknown values", () => {
  assert.equal(product.normalizeSettings({ fontFamily: "jetbrains-mono" }).fontFamily, "jetbrains-mono");
  assert.equal(product.normalizeSettings({ fontFamily: "plus-jakarta-sans" }).fontFamily, "plus-jakarta-sans");
  assert.equal(product.normalizeSettings({ fontFamily: "figtree" }).fontFamily, "figtree");
  assert.equal(product.normalizeSettings({ fontFamily: "outfit" }).fontFamily, "outfit");
  assert.equal(product.normalizeSettings({ fontFamily: "dm-sans" }).fontFamily, "dm-sans");
  assert.equal(product.normalizeSettings({ fontFamily: "manrope" }).fontFamily, "manrope");
  assert.equal(product.normalizeSettings({ fontFamily: "atkinson" }).fontFamily, "atkinson");
  // Inter and Open Sans are exact faces now; the old ids showed the theme font.
  assert.equal(product.normalizeSettings({ fontFamily: "inter" }).fontFamily, "inter");
  assert.equal(product.normalizeSettings({ fontFamily: "opensans" }).fontFamily, "opensans");
  assert.equal(product.normalizeSettings({ fontFamily: "open-sans" }).fontFamily, "theme");
  assert.equal(product.normalizeSettings({ fontFamily: "sans" }).fontFamily, "theme");
  assert.equal(product.normalizeSettings({ fontFamily: "montserrat" }).fontFamily, "montserrat");
  assert.equal(product.normalizeSettings({ fontFamily: "roboto" }).fontFamily, "roboto");
  assert.equal(product.normalizeSettings({ fontFamily: "noto-sans" }).fontFamily, "noto-sans");
  assert.equal(product.normalizeSettings({ fontFamily: "berkeley-mono" }).fontFamily, "jetbrains-mono");
  assert.equal(product.normalizeSettings({ fontFamily: "unknown-font" }).fontFamily, "theme");
  assert.ok(product.INTERFACE_FONTS.filter((font) => font.mono).length >= 5);
  assert.ok(product.INTERFACE_FONTS.filter((font) => !font.mono).length >= 8);
  assert.ok(product.INTERFACE_FONTS.length <= 20);
});

test("the kept pinned window is on by default, and an opt-in era false switches on once", () => {
  assert.equal(ui.UI_DEFAULTS.sharedPinnedWindow, true);
  assert.equal(ui.parseUiSettings(null).sharedPinnedWindow, true);
  // Written while the frame was opt-in: its false is the old default.
  assert.equal(ui.parseUiSettings(JSON.stringify({ sharedPinnedWindow: false })).sharedPinnedWindow, true);
  // Saved against the current default: the person's choice stands.
  const version = ui.UI_DEFAULTS.sharedPinnedWindowVersion;
  const off = ui.parseUiSettings(JSON.stringify({ sharedPinnedWindow: false, sharedPinnedWindowVersion: version }));
  assert.equal(off.sharedPinnedWindow, false);
  assert.equal(off.sharedPinnedWindowVersion, version);
  const reparsed = ui.parseUiSettings(JSON.stringify(off));
  assert.equal(reparsed.sharedPinnedWindow, false, "a saved opt-out survives the next load");
});

test("font size preferences are independent, bounded, and publish their roles", () => {
  assert.equal(product.DEFAULT_SETTINGS.fontSize, 14);
  assert.equal(product.DEFAULT_SETTINGS.chatFontSize, 15);
  assert.equal(product.TEXT_SCALE_BASE, 15, "the token scale does not move with the default size");
  assert.deepEqual(ui.parseUiSettings(null), ui.UI_DEFAULTS);
  const parsed = ui.parseUiSettings(JSON.stringify({
    headerFontSize: 40.6,
    subheaderFontSize: 12,
    terminalFontSize: 18,
    editorFontSize: 20,
  }));
  assert.deepEqual(
    {
      header: parsed.headerFontSize,
      subheader: parsed.subheaderFontSize,
      terminal: parsed.terminalFontSize,
      editor: parsed.editorFontSize,
    },
    { header: 41, subheader: 12, terminal: 18, editor: 20 },
  );
  assert.equal(ui.parseUiSettings(JSON.stringify({ headerFontSize: 100 })).headerFontSize, 24);

  const properties = new Map<string, string>();
  const rootProperties = new Map<string, string>();
  const documentBefore = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    documentElement: { style: { setProperty: (name: string, value: string) => rootProperties.set(name, value) } },
    body: { dataset: {}, style: { setProperty: (name: string, value: string) => properties.set(name, value) } },
  };
  try {
    ui.applyUiSettings(parsed);
  } finally {
    if (documentBefore === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = documentBefore;
  }
  assert.equal(properties.get("--header-font-size"), "41px");
  assert.equal(properties.get("--subheader-font-size"), "12px");
  assert.equal(properties.get("--terminal-font-size"), "18px");
  assert.equal(properties.get("--editor-font-size"), "20px");
  assert.equal(rootProperties.get("--editor-font-size"), "20px");
});

test("merge conflict agent settings default safely and accept supported targets", () => {
  const defaults = product.normalizeSettings({});
  assert.match(defaults.conflictAgentPrompt, /resolve them, explaining each decision/);
  assert.equal(defaults.conflictAgentTarget, "new-session");
  assert.equal(
    product.normalizeSettings({ conflictAgentTarget: "current-session", conflictAgentPrompt: "Custom" }).conflictAgentTarget,
    "current-session",
  );
  assert.equal(product.normalizeSettings({ conflictAgentTarget: "other" }).conflictAgentTarget, "new-session");
});

test("navigator session defaults to six and accepts bounded custom counts", () => {
  assert.equal(product.DEFAULT_SETTINGS.defaultVisibleSessionCount, 6);
  assert.equal(product.normalizeSettings({}).defaultVisibleSessionCount, 6);
  assert.equal(product.normalizeSettings({ defaultVisibleSessionCount: 21 }).defaultVisibleSessionCount, 21);
  assert.equal(product.normalizeSettings({ defaultVisibleSessionCount: 0 }).defaultVisibleSessionCount, 1);
  assert.equal(product.normalizeSettings({ defaultVisibleSessionCount: 1001 }).defaultVisibleSessionCount, 1000);
});

test("archived sessions are collapsed by default", () => {
  assert.equal(product.DEFAULT_SETTINGS.showArchived, false);
  assert.equal(product.normalizeSettings({}).showArchived, false);
  assert.equal(product.normalizeSettings({ showArchived: true }).showArchived, true);
});

test("failed startup sessions are cleaned up by default and can be retained", () => {
  assert.equal(product.DEFAULT_SETTINGS.autoDeleteFailedStartupSessions, true);
  assert.equal(product.normalizeSettings({}).autoDeleteFailedStartupSessions, true);
  assert.equal(product.normalizeSettings({ autoDeleteFailedStartupSessions: false }).autoDeleteFailedStartupSessions, false);
});

test("send shortcuts default safely, preserve legacy behavior, and match only their configured key", () => {
  const defaults = product.normalizeSettings({});
  assert.equal(defaults.desktopSendShortcut, "enter");
  assert.equal(defaults.mobileSendShortcut, "none");
  assert.equal(product.normalizeSettings({ sendOnEnter: false }).desktopSendShortcut, "shift-enter");
  const configured = product.normalizeSettings({ desktopSendShortcut: "shift-enter", mobileSendShortcut: "enter" });
  assert.equal(product.matchesSendShortcut(configured.desktopSendShortcut, true), true);
  assert.equal(product.matchesSendShortcut(configured.desktopSendShortcut, false), false);
  assert.equal(product.matchesSendShortcut(configured.mobileSendShortcut, false), true);
  assert.equal(product.matchesSendShortcut(defaults.mobileSendShortcut, false), false);
});

test("saving either settings domain preserves the other domain byte-for-byte", () => {
  const uiBefore = stored.get(ui.UI_SETTINGS_KEY);
  product.saveSettings({ ...product.loadSettings(), productName: "Product only" });
  assert.equal(stored.get(ui.UI_SETTINGS_KEY), uiBefore);

  const productBefore = stored.get(product.SETTINGS_KEY);
  ui.setUiSettings({ chatWidth: "normal" });
  assert.equal(stored.get(product.SETTINGS_KEY), productBefore);
  assert.equal(product.loadSettings().productName, "Product only");
  assert.equal(ui.getUiSettings().chatWidth, "normal");
  assert.equal(stored.get("polyth.settings")?.includes("Legacy name"), true, "migration source remains read-only");
});

test("header metric and response action layouts preserve order and reject unknown ids", () => {
  const parsed = ui.parseUiSettings(JSON.stringify({
    headerMetrics: ["cost", "tokens", "bogus", "cost"],
    assistantMessageActions: {
      items: [{ id: "pin", placement: "menu" }, { id: "copy", placement: "bar" }, { id: "unknown", placement: "bar" }],
      reveal: "always",
      touch: "bogus",
    },
  }));
  assert.deepEqual(parsed.headerMetrics, ["cost", "tokens"]);
  assert.deepEqual(parsed.assistantMessageActions.items.slice(0, 2), [
    { id: "pin", placement: "menu" },
    { id: "copy", placement: "bar" },
  ]);
  assert.deepEqual(parsed.assistantMessageActions.items.map((item) => item.id).sort(), [...ui.RESPONSE_ACTION_IDS].sort());
  assert.equal(parsed.assistantMessageActions.reveal, "always");
  assert.equal(parsed.assistantMessageActions.touch, "menu");
  const defaults = ui.parseUiSettings(null);
  assert.deepEqual(defaults.headerMetrics, [...ui.HEADER_METRIC_IDS]);
  assert.deepEqual(defaults.assistantMessageActions, ui.UI_DEFAULTS.assistantMessageActions);
  assert.deepEqual(defaults.userMessageActions, ui.UI_DEFAULTS.userMessageActions);
});

test("a legacy responseActions list migrates into the shared assistant layout", () => {
  const custom = ui.parseUiSettings(JSON.stringify({ responseActions: ["pin", "copy", "unknown"] }));
  assert.deepEqual(
    custom.assistantMessageActions.items.filter((item) => item.placement === "bar").map((item) => item.id),
    ["info", "pin", "copy", "regenerate"],
  );
  assert.deepEqual(
    custom.assistantMessageActions.items.filter((item) => item.placement === "off").map((item) => item.id).sort(),
    ["image", "session"],
  );
  const untouched = ui.parseUiSettings(JSON.stringify({ responseActions: ["copy", "image", "plan", "pin", "session", "multirun"] }));
  assert.deepEqual(untouched.assistantMessageActions, ui.UI_DEFAULTS.assistantMessageActions);
});

test("top rail alignment defaults to center and accepts only supported positions", () => {
  assert.equal(ui.parseUiSettings(null).topRailAlignment, "center");
  assert.equal(ui.parseUiSettings(JSON.stringify({ topRailAlignment: "left" })).topRailAlignment, "left");
  assert.equal(ui.parseUiSettings(JSON.stringify({ topRailAlignment: "floating" })).topRailAlignment, "center");
});

test("session activity details default to the combined view and accept tabs", () => {
  assert.equal(ui.parseUiSettings(null).sessionActivityDetails, "all");
  assert.equal(ui.parseUiSettings("{}").sessionActivityDetails, "tabs", "a saved record keeps its earlier default");
  assert.equal(ui.parseUiSettings(JSON.stringify({ sessionActivityDetails: "all" })).sessionActivityDetails, "all");
  assert.equal(ui.parseUiSettings(JSON.stringify({ sessionActivityDetails: "split" })).sessionActivityDetails, "tabs");
});

test("activity block and composer status looks default to thread/line and survive storage", () => {
  for (const raw of [null, "{}"]) {
    assert.equal(ui.parseUiSettings(raw).activityBlockStyle, "thread");
    assert.equal(ui.parseUiSettings(raw).composerStatusStyle, "line");
  }
  for (const invalid of ["card", "glass", false, 0, null]) {
    const parsed = ui.parseUiSettings(JSON.stringify({ activityBlockStyle: invalid, composerStatusStyle: invalid }));
    assert.equal(parsed.activityBlockStyle, "thread");
    assert.equal(parsed.composerStatusStyle, "line");
  }
  const before = ui.getUiSettings();
  try {
    for (const activityBlockStyle of ui.ACTIVITY_BLOCK_STYLES) {
      ui.setUiSettings({ activityBlockStyle });
      assert.equal(ui.parseUiSettings(stored.get(ui.UI_SETTINGS_KEY) ?? null).activityBlockStyle, activityBlockStyle);
    }
    for (const composerStatusStyle of ui.COMPOSER_STATUS_STYLES) {
      ui.setUiSettings({ composerStatusStyle });
      assert.equal(ui.parseUiSettings(stored.get(ui.UI_SETTINGS_KEY) ?? null).composerStatusStyle, composerStatusStyle);
    }
  } finally {
    ui.setUiSettings(before);
  }
});

test("phone session title modes default safely and survive preference storage", () => {
  assert.equal(ui.parseUiSettings(null).mobileSessionTitle, "hidden");
  assert.equal(ui.parseUiSettings("{}").mobileSessionTitle, "title", "a saved record keeps its earlier default");
  // `logo` is the retired title-with-provider-logo mode.
  for (const invalid of ["unknown", "logo", false, 0, null]) {
    assert.equal(ui.parseUiSettings(JSON.stringify({ mobileSessionTitle: invalid })).mobileSessionTitle, "title");
  }
  const before = ui.getUiSettings();
  try {
    for (const mobileSessionTitle of ["hidden", "title", "button"] as const) {
      ui.setUiSettings({ mobileSessionTitle });
      assert.equal(ui.parseUiSettings(stored.get(ui.UI_SETTINGS_KEY) ?? null).mobileSessionTitle, mobileSessionTitle);
      assert.equal(ui.getUiSettings().mobileSessionTitle, mobileSessionTitle);
    }
  } finally {
    ui.setUiSettings(before);
  }
});

test("glass effect defaults to matte, validates modes, and applies globally", () => {
  assert.equal(ui.parseUiSettings(null).glassEffect, "matte");
  assert.equal(ui.parseUiSettings(null).hideBorders, true);
  assert.equal(ui.parseUiSettings(JSON.stringify({ hideBorders: false })).hideBorders, false);
  assert.equal(ui.parseUiSettings(JSON.stringify({ hideBorders: "false" })).hideBorders, true);
  assert.equal(ui.parseUiSettings(JSON.stringify({ glassEffect: "clear" })).glassEffect, "clear");
  assert.equal(ui.parseUiSettings(JSON.stringify({ glassEffect: "opaque" })).glassEffect, "matte");

  const dataset: Record<string, string> = {};
  const documentBefore = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    documentElement: { style: { setProperty() {} } },
    body: { dataset, style: { setProperty() {} } },
  };
  try {
    ui.applyUiSettings(ui.parseUiSettings(JSON.stringify({ glassEffect: "off" })));
  } finally {
    if (documentBefore === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = documentBefore;
  }
  assert.equal(dataset.glass, "off");
});

test("the retired context indicator mode is dropped from stored and synced records", () => {
  // The header donut was replaced by the liquid fill of the running composer
  // action; an old record must not resurrect the preference.
  for (const contextIndicatorMode of ["donut", "logo"]) {
    const parsed = ui.parseUiSettings(JSON.stringify({ contextIndicatorMode, glassEffect: "clear" }));
    assert.equal(Object.hasOwn(parsed, "contextIndicatorMode"), false);
    assert.equal(parsed.glassEffect, "clear", "the rest of the record still parses");
  }
});

test("rail sizes default safely, migrate legacy values, and publish token geometry", () => {
  const defaults = ui.parseUiSettings(null);
  assert.equal(defaults.leftRailSize, 100);
  assert.equal(defaults.rightRailSize, 90);
  assert.equal(defaults.topRailSize, 100);
  assert.equal(ui.parseUiSettings("{}").rightRailSize, 100, "a saved record keeps its earlier default");

  const configured = ui.parseUiSettings(JSON.stringify({
    leftRailSize: 80,
    topRailSize: 120,
    rightRailSize: 115,
  }));
  assert.equal(configured.leftRailSize, 80);
  assert.equal(configured.topRailSize, 120);
  assert.equal(configured.rightRailSize, 115);

  // Legacy discrete records migrate to the nearest percentage.
  assert.equal(ui.parseUiSettings(JSON.stringify({ topRailIconSize: "sm" })).topRailSize, 90);
  assert.equal(ui.parseUiSettings(JSON.stringify({ rightRailIconSize: "lg" })).rightRailSize, 110);
  // Unknown or out-of-range values fall back or clamp; they never drop the record.
  assert.equal(ui.parseUiSettings(JSON.stringify({ topRailSize: "huge" })).topRailSize, 100);
  assert.equal(ui.parseUiSettings(JSON.stringify({ topRailSize: 900 })).topRailSize, 130);
  assert.equal(ui.parseUiSettings(JSON.stringify({ leftRailSize: 1 })).leftRailSize, 70);

  const properties = new Map<string, string>();
  const documentBefore = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    documentElement: {
      style: { setProperty: (name: string, value: string) => properties.set(name, value) },
    },
    body: {
      dataset: {},
      style: { setProperty: (name: string, value: string) => properties.set(name, value) },
    },
  };
  try {
    ui.applyUiSettings(configured);
  } finally {
    if (documentBefore === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = documentBefore;
  }

  assert.equal(properties.get("--rail-scale-left"), "0.8");
  assert.equal(properties.get("--rail-scale-top"), "1.2");
  assert.equal(properties.get("--rail-scale-right"), "1.15");
  assert.equal(properties.get("--rail-icon-size-left"), "calc(var(--control-h-sm) * 0.8)");
  assert.equal(properties.get("--rail-icon-glyph-left"), "calc(var(--icon-rail) * 0.8)");
  assert.equal(properties.get("--rail-icon-size-top"), "calc(var(--control-h-sm) * 1.2)");
  assert.equal(properties.get("--rail-icon-glyph-top"), "calc(var(--icon-md) * 1.2)");
  assert.equal(properties.get("--rail-icon-size-right"), "calc(var(--control-h-sm) * 1.15)");
  assert.equal(properties.get("--rail-icon-glyph-right"), "calc(var(--icon-rail) * 1.15)");
  assert.equal(
    properties.get("--rail-strip-width-right"),
    "calc(var(--rail-icon-size-right) + var(--space-3) + 1px)",
  );
});

test("the top rail surface floats on fresh installs, keeps existing profiles' rail and publishes the choice", () => {
  assert.equal(ui.parseUiSettings(null).topRailSurface, "floating");
  assert.equal(ui.UI_DEFAULTS.topRailSurface, "floating");
  // An existing profile has no topRailSurface field, so it must keep the
  // bottom edge it was built with rather than silently flattening.
  assert.equal(ui.parseUiSettings("{}").topRailSurface, "shadow");
  assert.equal(ui.parseUiSettings(JSON.stringify({ hideBorders: false })).topRailSurface, "shadow");

  for (const surface of ["shadow", "flat", "floating"] as const) {
    assert.equal(ui.parseUiSettings(JSON.stringify({ topRailSurface: surface })).topRailSurface, surface);
  }
  // Unknown values fall back instead of disabling the rail's own chrome.
  for (const bogus of ["", "none", "transparent", 1, null, { flat: true }]) {
    assert.equal(
      ui.parseUiSettings(JSON.stringify({ topRailSurface: bogus })).topRailSurface,
      "shadow",
      `${JSON.stringify(bogus)} is not a top rail surface`,
    );
  }
  assert.deepEqual([...ui.TOP_RAIL_SURFACES], ["shadow", "flat", "floating"]);

  const dataset: Record<string, string> = {};
  const documentBefore = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    documentElement: { style: { setProperty: () => {} } },
    body: { dataset, style: { setProperty: () => {} } },
  } as unknown as Document;
  try {
    for (const topRailSurface of ["shadow", "flat", "floating"] as const) {
      ui.applyUiSettings(ui.parseUiSettings(JSON.stringify({ topRailSurface })));
    }
  } finally {
    if (documentBefore === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = documentBefore;
  }
  // CSS reads the surface off <body>, so the last applied choice must be there.
  assert.equal(dataset.topRailSurface, "floating");
});

test("the interface style defaults to the standard shell, round-trips every look and publishes it", () => {
  assert.equal(ui.UI_DEFAULTS.shellLook, "standard");
  // Fresh installs and records saved before the setting existed keep today's shell.
  assert.equal(ui.parseUiSettings(null).shellLook, "standard");
  assert.equal(ui.parseUiSettings("{}").shellLook, "standard");
  assert.deepEqual(
    [...ui.SHELL_LOOKS],
    ["standard", "paper", "line", "air", "monolith", "monolith-reverse", "obsidian", "editorial"],
  );
  for (const look of ui.SHELL_LOOKS) {
    assert.equal(ui.parseUiSettings(JSON.stringify({ shellLook: look })).shellLook, look);
  }
  for (const bogus of ["", "glass", "Paper", 1, null, { look: "air" }]) {
    assert.equal(
      ui.parseUiSettings(JSON.stringify({ shellLook: bogus })).shellLook,
      "standard",
      `${JSON.stringify(bogus)} is not an interface style`,
    );
  }

  const dataset: Record<string, string> = {};
  const documentBefore = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = {
    documentElement: { style: { setProperty: () => {} } },
    body: { dataset, style: { setProperty: () => {} } },
  } as unknown as Document;
  try {
    ui.applyUiSettings(ui.parseUiSettings(JSON.stringify({ shellLook: "monolith-reverse" })));
    assert.equal(dataset.shellLook, "monolith-reverse");
    ui.applyUiSettings(ui.parseUiSettings("{}"));
    assert.equal(dataset.shellLook, "standard", "switching back must clear the previous look");
  } finally {
    if (documentBefore === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = documentBefore;
  }
});

test("mobile shortcut settings preserve order and reject unknown or duplicate ids", () => {
  assert.deepEqual(ui.parseUiSettings(null).mobileShortcuts, ui.UI_DEFAULTS.mobileShortcuts);
  assert.deepEqual(
    ui.parseUiSettings(JSON.stringify({
      mobileShortcuts: ["settings", "files", "bogus", "files", "notification-centre"],
    })).mobileShortcuts,
    ["settings", "files", "notification-centre"],
  );
});

test("prompt history settings default to the current session and 40 prompts", () => {
  const defaults = ui.parseUiSettings(null);
  assert.equal(defaults.promptHistoryScope, "session");
  assert.equal(defaults.promptHistoryLimit, 40);
  const parsed = ui.parseUiSettings(JSON.stringify({
    promptHistoryScope: "server",
    promptHistoryLimit: 12.6,
  }));
  assert.equal(parsed.promptHistoryScope, "space");
  assert.equal(parsed.promptHistoryLimit, 13);
  assert.equal(ui.parseUiSettings(JSON.stringify({ promptHistoryScope: "space" })).promptHistoryScope, "space");
  assert.equal(ui.parseUiSettings(JSON.stringify({ promptHistoryScope: "nope" })).promptHistoryScope, "session");
  assert.equal(ui.parseUiSettings(JSON.stringify({ promptHistoryLimit: 0 })).promptHistoryLimit, 1);
  assert.equal(ui.parseUiSettings(JSON.stringify({ promptHistoryLimit: 9999 })).promptHistoryLimit, 200);
});

test("prompt bookmark preference defaults off and accepts only an explicit true", () => {
  const defaults = ui.parseUiSettings(null);
  assert.equal(defaults.pinLatestPrompt, false);
  assert.equal(ui.parseUiSettings(JSON.stringify({ pinLatestPrompt: true })).pinLatestPrompt, true);
  assert.equal(ui.parseUiSettings(JSON.stringify({ pinLatestPrompt: "yes" })).pinLatestPrompt, false);
  assert.equal(ui.parseUiSettings(JSON.stringify({ pinLatestPrompt: false })).pinLatestPrompt, false);
});

test("desktop prompt bookmark is a separate opt-in and the rail can be switched off", () => {
  const defaults = ui.parseUiSettings(null);
  assert.equal(defaults.promptBookmarkDesktop, false);
  assert.equal(defaults.promptNavigator, "auto");
  // An existing phone bookmark opt-in does not turn the desktop bookmark on.
  assert.equal(ui.parseUiSettings(JSON.stringify({ pinLatestPrompt: true })).promptBookmarkDesktop, false);
  assert.equal(ui.parseUiSettings(JSON.stringify({ promptBookmarkDesktop: true })).promptBookmarkDesktop, true);
  assert.equal(ui.parseUiSettings(JSON.stringify({ promptBookmarkDesktop: "yes" })).promptBookmarkDesktop, false);
  assert.equal(ui.parseUiSettings(JSON.stringify({ promptNavigator: "off" })).promptNavigator, "off");
});

test("legacy latest-user pin preference is ignored by the UI settings parser", () => {
  const parsed = ui.parseUiSettings(JSON.stringify({ pinLatestUserMessage: true }));
  assert.equal("pinLatestUserMessage" in parsed, false);
});

test("mirror layout defaults to false, validates booleans, and is included in App's mirror condition", async () => {
  assert.equal(ui.UI_DEFAULTS.mirrorLayout, false);
  assert.equal(ui.parseUiSettings(null).mirrorLayout, false);
  assert.equal(ui.parseUiSettings(JSON.stringify({ mirrorLayout: true })).mirrorLayout, true);
  assert.equal(ui.parseUiSettings(JSON.stringify({ mirrorLayout: false })).mirrorLayout, false);
  // Rejects non-boolean values and falls back to default false:
  assert.equal(ui.parseUiSettings(JSON.stringify({ mirrorLayout: "true" })).mirrorLayout, false);
  assert.equal(ui.parseUiSettings(JSON.stringify({ mirrorLayout: 1 })).mirrorLayout, false);
  assert.equal(ui.parseUiSettings(JSON.stringify({ mirrorLayout: 0 })).mirrorLayout, false);
  assert.equal(ui.parseUiSettings(JSON.stringify({ mirrorLayout: null })).mirrorLayout, false);
  assert.equal(ui.parseUiSettings(JSON.stringify({ mirrorLayout: {} })).mirrorLayout, false);

  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(
    app,
    /\(shellPresentation\.mirrored\s*\|\|\s*ui\.mirrorLayout\)\s*&&\s*shellMode\s*===\s*"wide"/,
    "App mirrors the shell when either the profile or mirrorLayout setting requests it in wide mode",
  );
});
