import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { composerLayoutState } from "../src/composerLayout.ts";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

/** Absolute points a simple path visits (M/m, implicit line-tos, L/l, A/a
 *  endpoints), tracking the running cursor for the relative commands the
 *  icon paths use. */
function pathPoints(d: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  let x = 0;
  let y = 0;
  let cmd = "M";
  let i = 0;
  const num = (): number => Number(tokens[i++]!);
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i]!)) cmd = tokens[i++]!;
    const abs = cmd === cmd.toUpperCase();
    const step = (px: number, py: number): void => {
      x = abs ? px : x + px;
      y = abs ? py : y + py;
      points.push([x, y]);
    };
    switch (cmd) {
      case "M": case "m": step(num(), num()); cmd = abs ? "L" : "l"; break;
      case "L": case "l": step(num(), num()); break;
      case "H": case "h": x = abs ? num() : x + num(); points.push([x, y]); break;
      case "V": case "v": y = abs ? num() : y + num(); points.push([x, y]); break;
      case "A": case "a": num(); num(); num(); num(); num(); step(num(), num()); break;
      case "Z": case "z": break;
      default: i++; // commands not used by these paths: resync, never hang
    }
  }
  return points;
}

test("send glyph inherits the contrasting theme ink instead of forcing white", async () => {
  const css = await read("../src/styles.css");
  const plane = css.match(/\.send-plane\s*\{([^}]*)\}/)?.[1];
  assert.ok(plane, "the send glyph wrapper is styled");
  assert.doesNotMatch(plane, /(?:^|;)\s*color\s*:/,
    "the glyph inherits the button ink in both dark and light themes");
  assert.match(css, /\.composer-simple \.composer-rail \.send\s*\{[^}]*color:\s*var\(--accent-ink\);/s);
});

test("phone composer keeps one text origin and one semantic control order", async () => {
  const css = await read("../src/composerAdaptive.css");
  assert.match(css, /padding:\s*var\(--space-3\) var\(--space-4\) var\(--space-1\);/,
    "placeholder, short drafts and multiline drafts share the same top-left padding");
  assert.match(css, /\.composer-mobile \.composer-leading-zone\b[\s\S]*?display:\s*contents;/,
    "the leading wrapper cannot lock Add and Voice into the wrong visual group");
  assert.match(css, /\.composer-mobile \.composer-add\s*\{[^}]*order:\s*1;/s,
    "Add stays at the far left");
  assert.match(css, /\.composer-mobile \.composer-execution\s*\{[^}]*order:\s*2;/s,
    "thinking and model sit between Add and mic in the leading section");
  assert.match(css, /\.composer-mobile \.composer-mobile-extensions\s*\{[^}]*order:\s*3;/s,
    "voice follows the execution slot in the leading section");
  assert.match(css, /\.composer-mobile \.composer-actions \{[^}]*margin-inline-start:\s*auto;/s,
    "the trailing block is pushed to the end of the engaged rail by its own auto margin");
  assert.match(css, /\.composer-mobile \.composer-rail\b[\s\S]*?gap:\s*7px;/s,
    "the rail and the extension lanes share one 7px rhythm, so the row reads as aligned blocks");
  assert.match(css, /\.composer-mobile \.model-picker-trigger \.model-trigger-logo\b[\s\S]*?display:\s*none;/,
    "the composer model trigger is text-only");
});

test("phone composer keeps desktop extension slots reachable in both composer states", async () => {
  const css = await read("../src/composerAdaptive.css");
  // Resting: the row is add · placeholder · voice · Send. The leading lane
  // holds one full tap box and the trailing lane stands down, so no control is
  // squeezed below a touch target beside Send.
  assert.match(css, /\.composer-mobile\.composer-collapsed \.composer-mobile-extensions\s*\{[^}]*width:\s*var\(--tap\);[^}]*max-width:\s*var\(--tap\);[^}]*flex:\s*0 0 var\(--tap\);/s,
    "the resting leading lane is exactly one input-method tap box");
  assert.match(css, /\.composer-mobile\.composer-collapsed \.composer-actions > \.composer-extensions\s*\{\s*display:\s*none;\s*\}/s,
    "no contributed trailing control sits beside Send at rest");
  // Engaged, the rail is its own row: the lanes keep their natural width and
  // only shrink (and scroll) when the row genuinely cannot fit them.
  assert.match(css, /\.composer-mobile\.composer-expanded \.composer-mobile-extensions,[\s\S]*?\.composer-mobile\.composer-expanded \.composer-actions > \.composer-extensions\s*\{\s*max-width:\s*none;\s*\}/s,
    "an engaged lane shows every contributed control instead of clipping a capped box");
  assert.match(css, /\.composer-mobile \.composer-mobile-extensions > \.placed-mini-widget,[\s\S]*?\.composer-mobile \.composer-actions > \.composer-extensions > \.placed-mini-widget\s*\{[^}]*display:\s*contents;/s,
    "contributed widgets keep their desktop controls instead of being discarded");
  assert.match(css, /\.composer-simple \.composer-primary \.send\s*\{[^}]*display:\s*inline-flex;/s,
    "Send remains visible as the terminal action even with an empty draft");
});

test("the primary action is terminal and draft engagement survives blur", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const primary = composer.indexOf('<span className="composer-primary">');
  const trailingCustomize = composer.indexOf('<CustomizeZoneButton slot="composer.trailing" />');
  assert.ok(primary > trailingCustomize, "the primary action follows trailing customization controls");
  const runningPrimary = composer.indexOf("className={`send composer-delivery");
  const menu = composer.indexOf('className="composer-send-options"');
  assert.ok(runningPrimary < menu, "the running primary precedes its chevron segment");
  const primaryContent = composer.slice(composer.indexOf("const primaryAction ="), composer.indexOf("const layoutState ="));
  assert.match(primaryContent, /className="send"/, "the shared primary action retains idle Send");
  assert.match(composer, /primary=\{primaryAction\}/, "mobile receives the same primary action as desktop");
  assert.match(composer, /abortSession\("composer"\)/, "composer stop is attributed, not a generic user abort");
  assert.match(
    composer,
    /event\.detail !== 0 && Date\.now\(\) - stopPointerAt\.current > 1000/,
    "a remounted Stop ignores click-through from the Send slot",
  );
  assert.equal(
    composerLayoutState({ phoneLayout: true, inputFocused: false, shellMode: false, hasDraft: true }),
    "phone-engaged",
    "a typed draft stays engaged after the input blurs",
  );
  assert.equal(
    composerLayoutState({ phoneLayout: true, inputFocused: false, shellMode: false, hasDraft: false }),
    "phone-resting",
    "an idle or working phone composer uses the compact resting row",
  );
  assert.equal(
    composerLayoutState({ phoneLayout: false, inputFocused: false, shellMode: false, hasDraft: false }),
    "desktop",
    "desktop keeps its existing non-phone layout",
  );
});

test("keyboard-open primary taps keep the send slot stable through click", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const send = composer.indexOf('className="send"');
  const runningPrimary = composer.indexOf("className={`send composer-delivery");
  assert.ok(send > -1 && runningPrimary > -1, "both primary send variants remain present");
  const sendBlock = composer.slice(send, composer.indexOf("</button>", send));
  const queueBlock = composer.slice(runningPrimary, composer.indexOf("</button>", runningPrimary));
  assert.match(
    sendBlock,
    /onPointerDown=\{onPrimaryPointerDown\}[\s\S]*?onClick=\{onPrimaryClick\}/,
    "idle Send admits the primary pointer lifecycle before click dispatches",
  );
  assert.match(
    queueBlock,
    /onPointerDown=\{onPrimaryPointerDown\}[\s\S]*?onKeyDown=\{onPrimaryKeyDown\}[\s\S]*?onClick=\{onPrimaryClick\}/,
    "active-run delivery uses the same first-touch admission as idle Send",
  );
});

test("mobile primary touch activation survives keyboard dismissal without a duplicate click", async () => {
  const composer = await read("../src/components/Composer.tsx");
  assert.match(
    composer,
    /onPointerDown=\{onPrimaryPointerDown\} onPointerUp=\{onPrimaryPointerUp\}[\s\S]*?onKeyDown=\{onPrimaryKeyDown\} onClick=\{onPrimaryClick\}/,
    "the primary Send slot owns the whole touch gesture (down, up, cancel)",
  );
  assert.match(
    composer,
    /activation\.touch = true;[\s\S]*?event\.preventDefault\(\);\n    startHold\(\);/,
    "touch pointerdown keeps focus on the editor and arms the save-as-draft hold",
  );
  const pointerUp = composer.slice(composer.indexOf("const onPrimaryPointerUp"), composer.indexOf("const onPrimaryPointerCancel"));
  assert.match(pointerUp, /if \(held\) return;[\s\S]*?if \(inside \|\| [^)]*\)\) send\(\);/,
    "a touch released on Send before the hold completes sends; one slid off does not");
  const pointerDown = composer.slice(composer.indexOf("const onPrimaryPointerDown"), composer.indexOf("const onPrimaryKeyDown"));
  assert.doesNotMatch(pointerDown, /\.blur\(\)/, "Send keeps the software keyboard open for the next message");
  assert.match(
    composer,
    /if \(activation\.touch && !keyboardClick\) \{[\s\S]*?activation\.touch = false;[\s\S]*?return;[\s\S]*?\}\n    activation\.touch = false;[\s\S]*?send\(\);/,
    "the delayed click from the same touch is consumed exactly once",
  );
  assert.match(
    composer,
    /if \(event\.pointerType !== "touch" && event\.pointerType !== "pen"\) \{[\s\S]*?return;/,
    "desktop mouse and keyboard activation remain on the existing click path",
  );
  assert.match(
    composer,
    /activation\.staleTouchClick = activation\.touch;[\s\S]*?activation\.touch = false;[\s\S]*?activation\.keyboard = true;/,
    "a legitimate keyboard activation disarms a touch whose synthetic click was suppressed",
  );
  assert.match(composer, /const keyboardClick = event\.detail === 0;/,
    "keyboard clicks are distinguished from pointer clicks at the click boundary",
  );
  const activation = composer.slice(composer.indexOf("const onPrimaryKeyDown"), composer.indexOf("const retryFailedSend"));
  assert.doesNotMatch(activation, /Date\.now|setTimeout/,
    "touch/click pairing is event-lifecycle based rather than timeout based",
  );

  // Causal state-machine proof for the two edge cases: a suppressed touch
  // click must not poison the next keyboard activation, while a delayed click
  // from the original touch must still be consumed as its duplicate.
  let armed = false;
  let staleTouchClick = false;
  let sends = 0;
  const touchDown = () => { armed = true; sends++; }; // down + up before the hold
  const keyboardDown = () => { staleTouchClick = armed; armed = false; };
  const click = (detail: number) => {
    const keyboardClick = detail === 0;
    if (staleTouchClick && !keyboardClick) { staleTouchClick = false; return; }
    if (armed && !keyboardClick) { armed = false; return; }
    armed = false;
    sends++;
  };
  touchDown();
  keyboardDown();
  click(0);
  assert.equal(sends, 2, "suppressed touch click does not swallow a later keyboard send");
  click(1);
  assert.equal(sends, 2, "a delayed click from the earlier touch is consumed after keyboard activation");
  touchDown();
  click(1);
  assert.equal(sends, 3, "the delayed synthetic click is consumed without a duplicate send");
});

test("thinking effort is offered beside the model and labelled by the picker", async () => {
  const picker = await read("../../../packages/models/widgets/ModelPicker.tsx");
  const composer = await read("../src/components/Composer.tsx");
  const css = await read("../../../packages/models/widgets/model-picker-styles.css");
  assert.ok(picker.includes("const variantMenu"));
  assert.ok(picker.includes('label={tr("composer.thinking")}'));
  assert.ok(picker.includes('variant: variant ?? ""'));
  assert.match(css, /\.model-thinking-trigger\s*\{/);
  // The composer's configuration row exposes the same discrete choice as one
  // quiet chip and reuses the picker's labels instead of minting its own.
  assert.ok(composer.includes("const effortEntries: MenuEntry[]"));
  assert.ok(composer.includes("thinkingVariantLabel("));
  assert.ok(composer.includes("thinking={pickerThinking}"), "the picker receives the controlled choice");
  assert.ok(
    composer.includes("const pickerThinking = composerThinkingChoice({"),
    "inherited defaults remain distinct from explicit and saved choices",
  );
  assert.ok(
    composer.includes("recordedSessionThinking(selectedModel, session?.model"),
    "a chat's recorded effort wins over a preference saved for the same model elsewhere",
  );
});

test("model picker owns effort and running send uses one scalable glyph", async () => {
  const widgets = await read("../src/widgets/builtinMiniWidgets.tsx");
  assert.ok(!widgets.includes("composer.effort"));

  const icons = await read("../src/components/ui/icons.ts");
  assert.ok(icons.includes('createLucideIcon("QueueSend"'), "the running send glyph has one SVG viewBox");
  assert.match(icons,
    /fill:\s*"currentColor",\s*fillRule:\s*"evenodd",\s*stroke:\s*"none"/,
    "the queue badge is one even-odd fill, so the plus is a hole rather than a painted colour");
  assert.match(icons, /d:\s*"M18\.2 0\.4a5\.4[\s\S]*?ZM17\.3 3\.2h1\.8[\s\S]*?Z"/,
    "the badge keeps the disc and the plus-shaped hole in one path");
  // The plus is a hole: whatever lies behind it shows through. The plane's old
  // tip sat at the disc centre, so its stroke filled the cross's middle and the
  // plus read as partial. Neither the plane nor the fold may visit the hole —
  // checked with the icon's 1-unit stroke half-width of margin, against the
  // hole cross the assertion above pins (horizontal bar 15.6..20.8 x 4.9..6.7,
  // vertical bar 17.3..19.1 x 3.2..8.4).
  const planeD = icons.match(/d:\s*"([^"]*)",\s*key:\s*"plane"/)?.[1] ?? "";
  const foldD = icons.match(/d:\s*"([^"]*)",\s*key:\s*"fold"/)?.[1] ?? "";
  assert.ok(planeD && foldD, "the plane and fold paths are present");
  const inPlusHole = (px: number, py: number): boolean =>
    (px >= 14.6 && px <= 21.8 && py >= 3.9 && py <= 7.7)
    || (px >= 16.3 && px <= 20.1 && py >= 2.2 && py <= 9.4);
  for (const [px, py] of [...pathPoints(planeD), ...pathPoints(foldD)]) {
    assert.ok(!inPlusHole(px, py),
      `the queue mark keeps the plus hole clear of strokes (${px}, ${py})`);
  }
  assert.doesNotMatch(icons, /var\(--accent\)/,
    "the glyph never paints a fixed colour the action fill might already be");

  const composer = await read("../src/components/Composer.tsx");
  const css = await read("../src/composerAdaptive.css");
  assert.match(composer, /followUp === "queue"\s*\? <QueueSendIcon aria-hidden="true" \/>/,
    "the queued running action renders one icon");
  assert.doesNotMatch(css, /composer-running-badge/,
    "the icon geometry does not depend on a positioned CSS badge");
});

test("a running turn uses a split only for sendable drafts and keeps Stop standalone", async () => {
  const composer = await read("../src/components/Composer.tsx");
  const css = await read("../src/composerAdaptive.css");
  const styles = await read("../src/styles.css");
  assert.match(composer, /const canStop = working;/, "the terminal control follows the running turn");
  assert.match(composer, /const runningHasSend = !sendDisabled;/, "an empty composer selects Stop");
  const canStopStart = composer.indexOf("{canStop ? (");
  const stopBranchStart = composer.indexOf(") : (", canStopStart);
  const split = composer.slice(canStopStart, stopBranchStart);
  const stop = composer.slice(stopBranchStart, composer.indexOf('<button className="send"', canStopStart));
  assert.match(split, /<div className="composer-send-split">/, "sendable drafts mount one split control");
  assert.ok(
    split.indexOf("className={`send composer-delivery") < split.indexOf('className="composer-send-options"'),
    "the running primary precedes the chevron",
  );
  assert.match(split, /onClick=\{onPrimaryClick\}/, "the primary action follows the configured delivery setting");
  assert.match(composer, /followUp === "queue"[\s\S]*?tr\("composer\.queue"\)/, "the queue preference names the primary action Queue");
  assert.doesNotMatch(split, /onClick=\{\(\) => send\(undefined, queueEdit \? undefined : "interrupt"\)\}/, "the primary action cannot silently interrupt a queued follow-up");
  assert.match(split, /id: "send-now"/, "Send now is available in the draft menu");
  assert.match(split, /<ChevronDownIcon \/>/);
  assert.doesNotMatch(split, /MoreIcon/);
  assert.match(stop, /className="stop composer-stop-primary context-liquid-host"/, "Stop is a standalone primary control");
  assert.doesNotMatch(stop, /composer-send-options|composer-send-menu/, "an empty running turn mounts no duplicate menu");

  assert.match(
    styles,
    /\.composer-rail \.composer-stop-primary\s*\{[^}]*min-width:\s*78px;[^}]*background:\s*color-mix\(in srgb, var\(--red\) 9%, var\(--elevated\)\);/s,
    "standalone Stop keeps its previous primary silhouette",
  );
  assert.match(
    styles,
    /\.composer-simple \.composer-stop-primary\s*\{[^}]*width:\s*44px;[^}]*border-radius:\s*50%;/s,
    "the composer Stop remains a compact round action",
  );
  assert.match(
    css,
    /\.composer-simple \.composer-rail \.composer-send-split\s*\{[^}]*gap:\s*0;[^}]*box-shadow:\s*var\(--shadow-sm\), inset/s,
    "the split owns one continuous divider and elevation",
  );
  assert.match(
    css,
    /\.composer-simple \.composer-rail \.composer-send-split > \.composer-send-options::before\s*\{[^}]*inline-size:\s*1px;/s,
    "the neutral segment has one internal divider",
  );
  assert.doesNotMatch(css, /\.composer-send-menu::after/, "the send submenu has no decorative diamond pointer");
  assert.match(
    css,
    /\.ui-menu\.composer-send-menu\s*\{[^}]*width:\s*max-content;[^}]*min-width:\s*0;/s,
    "the send submenu is only as wide as its Send now / Stop labels",
  );
  assert.match(
    css,
    /\.composer-mobile \.composer-send-split\s*\{[^}]*min-height:\s*var\(--tap\);[^}]*gap:\s*0;/s,
    "phones retain full touch segments without reopening the control gap",
  );
});

test("touch taps on composer controls activate without dismissing the keyboard", async () => {
  const composer = await read("../src/components/Composer.tsx");
  // The rule lives in the host keep-keyboard seam (mobileViewport.ts; behavior
  // pinned by composerKeepKeyboard.test.ts). The composer only opts in, so its
  // controls and every picker it opens share one rule.
  assert.match(composer, /ref=\{rootRef\}[\s\S]{0,240}data-keep-keyboard=""/,
    "the composer root opts into the keep-keyboard surface");
  assert.doesNotMatch(composer, /onMouseDownCapture=/,
    "no second composer-local focus rule competes with the shared seam");
});

test("touch engines never show a stuck hover on composer controls", async () => {
  const styles = await read("../src/styles.css");
  const adaptive = await read("../src/composerAdaptive.css");
  const unguarded = (css: string, selector: RegExp) => {
    // Strip every (hover: hover) block, then require the hover rule be gone.
    const outside = css.replace(/@media \(hover: hover\) \{(?:[^{}]|\{[^{}]*\})*\}/g, "");
    return selector.test(outside);
  };
  for (const selector of [
    /^\.ui-icon-btn:hover:not\(:disabled\)/m,
    /^\.ui-icon-btn--quiet:hover/m,
    /^\.ui-icon-btn--danger:hover/m,
    /^\.composer-rail \.send:hover/m,
    /^\.composer-simple \.composer-rail \.send:hover/m,
    /^\.composer-focus-light \.composer-add-trigger:hover/m,
  ]) assert.equal(unguarded(styles, selector), false, `${selector} is hover-capable only`);
  for (const selector of [/^\.composer-simple[^{]*\.composer-send-options:hover/m, /^\.composer-simple[^{]*context-liquid-host:hover/m]) {
    assert.equal(unguarded(adaptive, selector), false, `${selector} is hover-capable only`);
  }
  const widget = await readFile(new URL("../../../packages/permissions/widgets/index.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(widget, /disabled: busy \|\| context\.autoApproveBusy/,
    "the approve toggle does not dim between tap and the server's answer");
  assert.match(widget, /const openPicker = \(\) => \{\s*if \(pending\) return;/, "repeat taps while busy are ignored");
  assert.match(widget, /const set = \(setting: ApprovalSetting\) => \{\s*if \(pending \|\|/, "a level change in flight is never repeated");
});
