// The menu text size and the chat text size are two settings over two type
// surfaces, and every size preference is edited with one control. These checks
// pin that contract: which surface reads which scale, that the two scales are
// published independently, that a record written before the split keeps its
// chat caliber, and that the Appearance page exposes both controls.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { Window } from "happy-dom";
import { en } from "../src/i18n/locales/en.ts";

register("./tsxHooks.mjs", import.meta.url);

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The one rule that owns every size role, plus the surface bindings. */
async function typeSurfaceBlocks() {
  const tokens = await read("../src/tokens.css");
  const roles = tokens.slice(tokens.indexOf(":root,\n.focus-conversation,"));
  return {
    tokens,
    roles: roles.slice(0, roles.indexOf("\n}")),
    bindings: roles.slice(roles.indexOf(".focus-conversation,\n.widget-conversation {\n  --text-scale")),
  };
}

test("every size role is declared once, for both text surfaces", async () => {
  const { tokens, roles } = await typeSurfaceBlocks();

  // A custom property resolves its own var() references where it is declared,
  // so a role declared only on :root would keep the menu caliber inside a
  // conversation. The role list must therefore name the conversation surfaces
  // and the activity and prompt-history surfaces that reset to the menu scale.
  assert.match(roles, /^:root,\n\.focus-conversation,\n\.widget-conversation,\n\.activity-group,\n\.agent-status-dock,\n\.subagent-island,\n\.prompt-nav-panel \{/);
  for (const role of [
    "--font-input", "--font-body", "--font-label", "--font-window-title", "--font-meta", "--font-meta-lh",
    "--font-response", "--font-response-lh", "--font-response-heading", "--font-response-heading-lh",
    "--font-session-title", "--font-session-title-lh",
    "--font-activity-title", "--font-activity-title-lh",
    "--font-tool-label", "--font-tool-label-lh",
    "--font-technical", "--font-technical-lh",
    "--font-response-meta", "--font-response-meta-lh",
    // Font-derived geometry belongs to the same surface as the type.
    "--prose-gap", "--composer-max-input-height",
  ]) {
    assert.ok(roles.includes(`${role}:`), `${role} is declared for every text surface`);
  }

  // Roles read the surface multiplier, never the published menu scale directly.
  assert.doesNotMatch(tokens, /--font-[a-z-]+:[^;]*--ui-font-scale/);
  assert.doesNotMatch(tokens, /--(?:prose-gap|composer-max-input-height):[^;]*--ui-font-scale/);

  // The caliber of each role is unchanged by the split.
  for (const size of ["15px", "14.7px", "15.5px", "14px", "13.25px", "12.25px", "20px", "21px", "18px", "16px"]) {
    assert.ok(roles.includes(`calc(${size} * var(--text-scale, 1))`), `${size} role base is preserved`);
  }
  assert.match(roles, /--font-meta:\s*max\(11px, calc\(15px \* var\(--text-scale, 1\) \* \.8\)\)/);
  assert.match(roles, /--font-response-lh:\s*calc\(var\(--font-response\) \* 1\.5\)/);
  assert.match(roles, /--font-response-heading:\s*calc\(var\(--font-response\) \+ 1px\)/);
});

test("a conversation reads at the chat scale and the shell at the menu scale", async () => {
  const { tokens, bindings } = await typeSurfaceBlocks();

  assert.match(tokens, /--text-scale:\s*var\(--ui-font-scale, 1\)/);
  assert.match(bindings, /^\.focus-conversation,\n\.widget-conversation \{\n  --text-scale: var\(--chat-font-scale, 1\);/);
  // The chat scale is bound on a conversation surface and nowhere else.
  assert.equal((tokens.match(/--text-scale: var\(--chat-font-scale, 1\)/g) ?? []).length, 1);
  assert.equal((tokens.match(/--chat-font-size:/g) ?? []).length, 1);

  // The agent activity block inside a conversation resets to the menu scale.
  assert.match(tokens, /\.activity-group,\n\.agent-status-dock,\n\.subagent-island,\n\.prompt-nav-panel \{\n  --text-scale: var\(--ui-font-scale, 1\);\n\}/);

  // Editable controls inside a conversation keep the mobile no-zoom floor.
  assert.match(
    tokens,
    /@media \(pointer: coarse\) \{\n  \.focus-conversation,\n  \.widget-conversation,\n  \.activity-group \{\n    --font-input: max\(16px, calc\(15px \* var\(--text-scale, 1\)\)\);/,
  );
});

test("the agent activity block follows the menu text size and not the chat text size", async () => {
  const { tokens } = await typeSurfaceBlocks();
  assert.match(
    tokens,
    /:root,\n\.focus-conversation,\n\.widget-conversation,\n\.activity-group,\n\.agent-status-dock,\n\.subagent-island,\n\.prompt-nav-panel \{/,
    "activity group is declared as a type surface with the full role vocabulary",
  );
  assert.match(
    tokens,
    /\.activity-group,\n\.agent-status-dock,\n\.subagent-island,\n\.prompt-nav-panel \{\n  --text-scale: var\(--ui-font-scale, 1\);\n\}/,
    "activity group re-binds --text-scale to the menu scale",
  );

  // In the DOM, an activity block inside a conversation evaluates with the
  // menu scale rather than the surrounding chat scale.
  const host = dom.document.createElement("div");
  host.innerHTML = `
    <style>${tokens}</style>
    <div class="focus-conversation">
      <div class="bubble">Prose</div>
      <section class="activity-group">
        <div class="ui-run-summary">
          <div class="ui-run-summary-copy"><strong>Activity</strong></div>
        </div>
      </section>
      <div class="agent-status-dock"><strong>Claude</strong></div>
      <section class="subagent-island"><span class="subagent-branch-title">Child</span></section>
    </div>
  `;
  dom.document.body.appendChild(host);
  try {
    dom.document.documentElement.style.setProperty("--ui-font-scale", "1.2");
    dom.document.documentElement.style.setProperty("--chat-font-scale", "0.8");
    const conv = host.querySelector(".focus-conversation")!;
    const activity = host.querySelector(".activity-group")!;
    assert.equal(dom.getComputedStyle(conv).getPropertyValue("--text-scale").trim(), "0.8");
    assert.equal(dom.getComputedStyle(activity).getPropertyValue("--text-scale").trim(), "1.2");
    assert.match(dom.getComputedStyle(conv).getPropertyValue("--font-tool-label"), /0\.8/);
    assert.match(dom.getComputedStyle(activity).getPropertyValue("--font-tool-label"), /1\.2/);
    // The above-composer status dock is shell chrome: menu scale too.
    const dock = host.querySelector(".agent-status-dock")!;
    assert.equal(dom.getComputedStyle(dock).getPropertyValue("--text-scale").trim(), "1.2");
    assert.match(dom.getComputedStyle(dock).getPropertyValue("--font-label"), /1\.2/);
    // So is the subagent island it heads (its branch rows sit outside the line).
    const island = host.querySelector(".subagent-island")!;
    assert.equal(dom.getComputedStyle(island).getPropertyValue("--text-scale").trim(), "1.2");
    assert.match(dom.getComputedStyle(island).getPropertyValue("--font-tool-label"), /1\.2/);
  } finally {
    host.remove();
  }
});

test("window, dialog and sheet title bars share one chrome title role", async () => {
  const styles = await read("../src/styles.css");
  const moduleContent = await read("../src/moduleContent.css");
  const { roles } = await typeSurfaceBlocks();
  // A title bar is chrome: label caliber, so it never outweighs the content's
  // own heading or the user's Header size setting.
  assert.match(roles, /--font-window-title:\s*calc\(15px \* var\(--text-scale, 1\)\)/);
  for (const selector of [
    /\.module-view-title,\s*\.rail-fullscreen \.rail-title,\s*\.panel-sheet \.rail-title\s*\{/,
    /\.dialog-system-header h2\s*\{/,
    /\.sheet-title\s*\{/,
    /\.ui-dialog-title\s*\{/,
    /\.folder-dialog-title\s*\{/,
  ]) {
    const start = styles.search(selector);
    assert.ok(start >= 0, `${selector} exists`);
    const rule = styles.slice(start, styles.indexOf("}", start));
    assert.match(rule, /font-size:\s*var\(--font-window-title\)/, `${selector} uses the window title role`);
    assert.match(rule, /font-weight:\s*650/, `${selector} uses the title weight`);
  }
  assert.match(moduleContent, /\.module-view--phone \.module-view-title\s*\{[^}]*font-size:\s*var\(--font-window-title\)/);
});

test("a section heading sits one step below the Header size title", async () => {
  const ui = await import("../src/uiPrefs.ts");
  const { tokens } = await typeSurfaceBlocks();
  assert.match(tokens, /--font-title:\s*24px/);
  assert.match(tokens, /--font-heading:\s*18px/);
  assert.equal(ui.sectionHeadingSize(24), 18);
  assert.equal(ui.sectionHeadingSize(32), 24);
  assert.equal(ui.sectionHeadingSize(48), 36);
  // Never under the label caliber, and never above the title itself.
  assert.equal(ui.sectionHeadingSize(16), 15);
  assert.equal(ui.sectionHeadingSize(14), 14);
});

test("the two text sizes publish independent scales", async () => {
  const settings = await import("../src/settings.ts");
  const base = settings.DEFAULT_SETTINGS;
  // Record what the app publishes rather than reading it back through the DOM
  // implementation, so the assertion is about the contract and not happy-dom.
  const published = new Map<string, string>();
  const style = document.documentElement.style;
  const original = style.setProperty.bind(style);
  const publish = (next: { fontSize: number; chatFontSize: number }) => {
    published.clear();
    style.setProperty = (name: string, value: string) => {
      published.set(name, value);
      original(name, value);
    };
    try {
      settings.applySettingsToDom({ ...base, ...next });
    } finally {
      style.setProperty = original;
    }
  };

  publish({ fontSize: 18, chatFontSize: 12 });
  assert.equal(published.get("--ui-font-size"), "18px");
  assert.equal(published.get("--chat-font-size"), "12px");
  assert.equal(Number(published.get("--ui-font-scale")), 18 / 15);
  assert.equal(Number(published.get("--chat-font-scale")), 12 / 15);

  // Moving one size must not disturb the other.
  publish({ fontSize: 15, chatFontSize: 24 });
  assert.equal(Number(published.get("--ui-font-scale")), 1);
  assert.equal(Number(published.get("--chat-font-scale")), 24 / 15);
  assert.equal(published.get("--chat-font-size"), "24px");
});

test("a record written before the split keeps its chat caliber", async () => {
  const settings = await import("../src/settings.ts");

  // Before the split one control drove both surfaces; such a record carries no
  // chat size and must not silently reset a transcript to the default.
  assert.equal(settings.normalizeSettings({ fontSize: 20 }).chatFontSize, 20);
  assert.equal(settings.normalizeSettings({}).chatFontSize, 15);
  // An explicit chat size wins and stays independent of the menu size.
  assert.equal(settings.normalizeSettings({ fontSize: 20, chatFontSize: 13 }).chatFontSize, 13);
  assert.equal(settings.parseSettings(null).chatFontSize, 15);
  assert.equal(settings.parseSettings(JSON.stringify({ fontSize: 22 })).chatFontSize, 22);
  // Both sizes share one legal range.
  assert.equal(settings.normalizeSettings({ chatFontSize: 99 }).chatFontSize, settings.TEXT_SIZE_MAX);
  assert.equal(settings.normalizeSettings({ chatFontSize: 1 }).chatFontSize, settings.TEXT_SIZE_MIN);
  assert.equal(settings.normalizeSettings({ fontSize: 99 }).fontSize, settings.TEXT_SIZE_MAX);
});

test("the Appearance page edits both text sizes with the shared stepper", async () => {
  const [pages, registry] = await Promise.all([
    read("../src/components/settings/pages.tsx"),
    read("../src/settings/registry.ts"),
  ]);

  assert.match(pages, /label=\{chatTextSize\}[\s\S]{0,400}?value=\{settings\.chatFontSize\}/);
  assert.match(pages, /itemId="appearance\.chatFontSize"[\s\S]*?onChange=\{\(chatFontSize\) => updateSettings\(\{ chatFontSize \}\)\}/);
  assert.match(pages, /label=\{menuTextSize\}[\s\S]{0,400}?value=\{settings\.fontSize\}/);
  assert.match(pages, /itemId="appearance\.fontSize"[\s\S]*?onChange=\{\(fontSize\) => updateSettings\(\{ fontSize \}\)\}/);

  // Every size preference on the page uses one control, bounded by the shared
  // text-size range rather than a private copy of the numbers.
  for (const value of [
    "settings.chatFontSize",
    "settings.fontSize",
    "ui.headerFontSize",
    "ui.subheaderFontSize",
    "ui.terminalFontSize",
    "ui.editorFontSize",
    "ui.rounding",
  ]) {
    const at = pages.indexOf(`value={${value}}`);
    assert.ok(at > 0, `${value} is edited by a control`);
    assert.match(pages.slice(Math.max(0, at - 200), at), /<SizeStepper\s*$/, `${value} uses the shared stepper`);
  }
  // The three rail rows share one wrapper because they share the rail range.
  for (const [value, label] of [
    ["ui.leftRailSize", "leftRailSize"],
    ["ui.rightRailSize", "rightRailSize"],
    ["ui.topRailSize", "topRailSize"],
  ]) {
    assert.match(pages, new RegExp(`<RailSizeRange value=\\{${value}\\} label=\\{${label}\\}`), `${value} is a rail stepper`);
  }
  assert.match(
    pages,
    /function RailSizeRange\([\s\S]*?<SizeStepper\s+value=\{value\}\s+min=\{RAIL_SIZE_MIN\}\s+max=\{RAIL_SIZE_MAX\}\s+step=\{RAIL_SIZE_STEP\}\s+label=\{label\}\s+unit="%"\s+onChange=\{onChange\}/,
    "rail sizes are the same control over the shared rail range",
  );
  // Every text-size row shows its own result at the real size, so the six
  // sliders read as one family instead of six unrelated numbers.
  for (const value of [
    "settings.chatFontSize", "settings.fontSize", "ui.headerFontSize", "ui.subheaderFontSize",
    "ui.terminalFontSize", "ui.editorFontSize",
  ]) {
    const at = pages.indexOf("value={" + value + "}");
    assert.match(pages.slice(at, at + 400), /specimen={{ text: "Ag"/, value + " previews its own size");
  }
  // Header size keeps its own wider range; the text sizes share the store's.
  assert.match(pages, /value=\{ui\.headerFontSize\}[\s\S]{0,120}?min=\{HEADER_SIZE_MIN\}[\s\S]{0,40}?max=\{HEADER_SIZE_MAX\}/);
  assert.doesNotMatch(pages, /type="range"/, "no bespoke slider markup is left on the page");
  // Five per-surface rows plus the leading control that moves them together.
  assert.equal((pages.match(/min=\{TEXT_SIZE_MIN\}/g) ?? []).length, 6);
  assert.equal((pages.match(/max=\{TEXT_SIZE_MAX\}/g) ?? []).length, 6);
  assert.match(pages, /itemId="appearance\.textSize"[\s\S]{0,400}?onChange=\{shiftAllTextSizes\}/);
  assert.equal((pages.match(/min=\{RAIL_SIZE_MIN\}/g) ?? []).length, 1);

  // Reset restores both text sizes, not just the menu one.
  assert.match(pages, /updateSettings\(\{\s*fontSize: DEFAULT_SETTINGS\.fontSize,\s*chatFontSize: DEFAULT_SETTINGS\.chatFontSize,/);

  // Settings search describes the split, and each entry focuses its own row.
  assert.match(registry, /\{ id: "appearance\.chatFontSize", pageId: "appearance", label: tr\("settings\.pages\.chatTextSize"\)[\s\S]*?focusTarget: "appearance\.chatFontSize" \}/);
  assert.match(registry, /\{ id: "appearance\.fontSize", pageId: "appearance", label: tr\("settings\.pages\.menuTextSize"\)[\s\S]*?focusTarget: "appearance\.fontSize" \}/);
  assert.equal(en["settings.pages.chatTextSize"], "Chat text size");
  assert.equal(en["settings.pages.menuTextSize"], "Menu text size");
});

test("the stepper reads as one control: nudges, exact value, and a live specimen", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { SizeStepper } = await import("../src/components/settings/parts.tsx");

  const markup = renderToStaticMarkup(createElement(SizeStepper, {
    value: 15,
    min: 10,
    max: 32,
    label: "Chat text size",
    unit: "px",
    specimen: { text: "Ag" },
    onChange: () => {},
  }));
  assert.match(markup, /aria-label="Decrease Chat text size"/);
  assert.match(markup, /aria-label="Increase Chat text size"/);
  assert.match(markup, /aria-valuetext="15 px"/, "the track announces the value with its unit");
  assert.match(markup, /class="size-stepper-track"[^>]*min="10"[^>]*max="32"/);
  assert.match(markup, /style="font-size:15px"/, "the specimen renders at the selected size");
  assert.match(markup, /<b>15<\/b><i>px<\/i>/, "the readout keeps the number tabular and the unit quiet");
  assert.doesNotMatch(markup, /disabled/, "both ends are reachable from the default size");

  // Bounds are enforced by the control, so the extremes cannot be overshot.
  const atMin = renderToStaticMarkup(createElement(SizeStepper, {
    value: 10, min: 10, max: 32, label: "Menu text size", unit: "px", onChange: () => {},
  }));
  assert.match(atMin, /aria-label="Decrease Menu text size"[^>]*disabled|disabled[^>]*aria-label="Decrease Menu text size"/);
  assert.doesNotMatch(atMin, /aria-label="Increase Menu text size"[^>]*disabled/);
  const atMax = renderToStaticMarkup(createElement(SizeStepper, {
    value: 32, min: 10, max: 32, label: "Menu text size", unit: "px", onChange: () => {},
  }));
  assert.match(atMax, /aria-label="Increase Menu text size"[^>]*disabled|disabled[^>]*aria-label="Increase Menu text size"/);
  // A preference without a unit (corner rounding) reads against its scale.
  const bare = renderToStaticMarkup(createElement(SizeStepper, {
    value: 5, min: 0, max: 10, label: "Corner rounding", unit: "", onChange: () => {},
  }));
  assert.match(bare, /aria-valuetext="5 \/ 10"/);
  assert.match(bare, /<b>5<\/b><i>\/10<\/i>/);
});

test("the stepper visual follows the shell's control language", async () => {
  const styles = await read("../src/styles.css");

  assert.match(styles, /\.size-stepper \{[^}]*display: flex;[^}]*gap: var\(--space-2\)/s);
  assert.match(styles, /\.size-stepper-track \{[^}]*appearance: none;[^}]*min-width: 64px;[^}]*max-width: 168px/s);
  assert.match(styles, /\.size-stepper-track \{[^}]*linear-gradient\(90deg, var\(--accent\) var\(--p, 50%\), var\(--border\) var\(--p, 50%\)\)/s);
  assert.match(styles, /\.size-stepper-track::-webkit-slider-thumb \{[^}]*border-radius: 50%/s);
  assert.match(styles, /\.size-stepper-value \{[^}]*font-variant-numeric: tabular-nums/s);
  assert.match(styles, /\.size-stepper-specimen \{[^}]*color: var\(--text\)/s);
  assert.match(styles, /\.size-stepper-specimen\.is-mono \{[^}]*font-family: var\(--mono\)/s);
  // The narrow pane gives the track the room and drops the specimen.
  assert.match(
    styles,
    /@media \(max-width: 700px\)[\s\S]*?\.settings-pane-body \.size-stepper \{ width: 100%; \}[\s\S]*?\.settings-pane-body \.size-stepper-track \{ max-width: none; \}[\s\S]*?\.settings-pane-body \.size-stepper-specimen \{ display: none; \}/,
  );
  // The bespoke slider it replaced is gone, so there is one control to style.
  assert.doesNotMatch(styles, /\.rng-val/);
});
