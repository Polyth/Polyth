// Press and hold Send keeps the message as a draft. Both halves — whether the
// gesture exists and how long it takes — are a Settings > Chat preference, so
// these checks pin the stored value, the composer reading it, and the settings
// row that writes it. The mounted page checks live in chatSettingsPage.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SEND_HOLD_DEFAULT_MS,
  SEND_HOLD_MAX_MS,
  SEND_HOLD_MIN_MS,
  SEND_HOLD_OFF,
  SEND_HOLD_STEP_MS,
  parseSendHoldMs,
  sendHoldMs,
  inputTime,
  sendPressOutcome,
} from "../src/sendHold.ts";
import { UI_DEFAULTS, parseUiSettings } from "../src/uiPrefs.ts";

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("a hold length is snapped to the slider grid and kept inside its ends", () => {
  assert.equal(parseSendHoldMs(undefined), SEND_HOLD_DEFAULT_MS);
  assert.equal(parseSendHoldMs(0), SEND_HOLD_DEFAULT_MS, "0 is the off switch, not a length");
  assert.equal(parseSendHoldMs("nonsense"), SEND_HOLD_DEFAULT_MS);
  assert.equal(parseSendHoldMs(10), SEND_HOLD_MIN_MS, "below the floor");
  assert.equal(parseSendHoldMs(60_000), SEND_HOLD_MAX_MS, "above the ceiling");
  assert.equal(parseSendHoldMs(512), 500, "snapped to the nearest 50 ms");
  assert.equal(parseSendHoldMs(537), 550);
  assert.equal(parseSendHoldMs(1250), 1250);
  assert.equal(parseSendHoldMs(1250) % SEND_HOLD_STEP_MS, 0);
});

test("the off switch is a preference of its own, so the length survives it", () => {
  assert.equal(sendHoldMs({ sendHoldDraft: true, sendHoldDraftMs: 900 }), 900);
  assert.equal(sendHoldMs({ sendHoldDraft: false, sendHoldDraftMs: 900 }), SEND_HOLD_OFF);
  assert.equal(
    sendHoldMs({ sendHoldDraft: true, sendHoldDraftMs: 900 }),
    900,
    "turning the gesture back on restores the person's own length",
  );
});

test("a stored profile without the gesture keeps it on at the length it always had", () => {
  const defaults = parseUiSettings(null);
  assert.equal(defaults.sendHoldDraft, true);
  assert.equal(defaults.sendHoldDraftMs, 500);
  const saved = parseUiSettings(JSON.stringify({ sendHoldDraft: false, sendHoldDraftMs: 1500 }));
  assert.equal(saved.sendHoldDraft, false);
  assert.equal(saved.sendHoldDraftMs, 1500);
  const broken = parseUiSettings(JSON.stringify({ sendHoldDraftMs: "1200" }));
  assert.equal(broken.sendHoldDraftMs, 1200, "a numeric string from an older record still reads");
});

test("the composer arms the hold for the chosen length, or not at all when it is off", () => {
  const composer = read("components/Composer.tsx");
  assert.match(composer, /sendHoldRef\.current = sendHoldMs\(uiPrefs\);/,
    "the pointer callbacks read the live preference, not a value frozen at mount");
  const canPark = composer.slice(composer.indexOf("canParkRef.current = () =>"), composer.indexOf("const [parked, setParked]"));
  assert.match(canPark, /sendHoldRef\.current > 0/, "an off gesture can never park a message");
  assert.match(composer, /holdMs: \(\) => \(canParkRef\.current\(\) \? sendHoldRef\.current : 0\),/,
    "the press is armed for the person's length, and for none when the message cannot be kept");
  assert.doesNotMatch(composer, /SEND_HOLD_MS/, "no hardcoded hold survives in the composer");
});

test("every press ends as a send or a draft, split at the hold length with no gap", () => {
  assert.equal(sendPressOutcome(0, 500), "send");
  assert.equal(sendPressOutcome(499, 500), "send", "just short of the hold sends");
  assert.equal(sendPressOutcome(500, 500), "draft", "the hold length itself keeps a draft");
  assert.equal(sendPressOutcome(5_000, 500), "draft");
  assert.equal(sendPressOutcome(5_000, SEND_HOLD_OFF), "send", "with the gesture off every press sends");
});

test("a press is timed by its input stamps, on the performance clock", () => {
  assert.equal(inputTime(1_200, 1_900), 1_200, "a lift handled late keeps the time it happened");
  assert.equal(inputTime(undefined, 1_900), 1_900);
  assert.equal(inputTime(0, 1_900), 1_900, "an engine without a stamp falls back to now");
  assert.equal(inputTime(Number.NaN, 1_900), 1_900);
  assert.equal(inputTime(5_000, 1_900), 1_900, "a stamp from the future is not on this clock");
  assert.equal(inputTime(1_763_000_000_000, 1_900), 1_900, "an epoch stamp is not on this clock");
});

test("Send is one press controller that judges every press from its own input stamps", () => {
  const composer = read("components/Composer.tsx");
  assert.match(composer, /return attachSendPress\(button, \{[\s\S]*?onSend: \(\) => sendRef\.current\?\.\(\),\s*onDraft: keepHeldDraft,\s*onCue: showHoldCue,\s*onCueDropped: dropHoldCue,/,
    "the composer hands the controller its send, draft and cue handlers");
  assert.equal(composer.match(/ref=\{sendPressRef\}/g)?.length, 2, "both Send buttons carry the one controller");
  assert.doesNotMatch(composer, /performance\.now\(\) - hold/, "no handler-time measurement decides a press");
  assert.doesNotMatch(composer, /onPrimaryPointer|onPrimaryClick|watchTouchEnd|settleHold/, "no per-handler press logic is left on the buttons");
});

test("the browser cannot pan a held Send away, which used to drop the press entirely", () => {
  // A finger rolls a few pixels while it holds. With panning allowed the
  // browser took that for a scroll and cancelled the press: no send, no draft.
  const styles = read("styles.css");
  const rule = /:is\(\.send, \.composer-delivery\) \{([^}]*)\}/.exec(styles);
  assert.ok(rule, "Send has its own gesture rule");
  assert.match(rule[1]!, /touch-action: none;/, "a held Send is never handed to the browser as a pan");
  assert.match(rule[1]!, /-webkit-touch-callout: none;/);
});

test("the ring is drawn for the chosen length, and its hint disappears when the gesture is off", () => {
  const composer = read("components/Composer.tsx");
  assert.match(composer, /"--send-hold-ms": `\$\{sendHoldRef\.current\}ms`/,
    "the button publishes the length it is waiting for");
  assert.match(composer, /const holdHint = uiPrefs\.sendHoldDraft \? ` · \$\{tr\("composer\.holdToSaveDraft"\)\}` : "";/,
    "a disabled gesture promises nothing in the tooltip");
  const styles = read("styles.css");
  assert.match(styles, /animation: send-hold-wind var\(--send-hold-ms, 500ms\) linear var\(--send-hold-age, 0ms\) both;/);
  assert.match(styles, /transition: transform var\(--send-hold-ms, 500ms\) var\(--motion-ease\);/);
  assert.doesNotMatch(styles, /send-hold-wind 500ms linear/);
  assert.match(composer, /className="send-hold-ring"[\s\S]*?className="send-hold-ring"/,
    "the running delivery button draws the same ring as idle Send");
  // An SVG circle took the phone's `.send svg` glyph size (18px) and sat in
  // Send's corner, and cut across the corners of a rounded-square Send.
  assert.doesNotMatch(composer, /<circle /, "the ring is a box in Send's own shape, not an SVG circle");
  assert.match(styles, /border-radius: calc\(var\(--send-hold-radius, var\(--radius-round\)\) \+ 4px\);/);
  const field = read("components/settings/SendHoldField.tsx");
  assert.match(field, /attachSendPress\(/, "the settings trial runs the composer's own press");
  assert.match(field, /className="send-hold-ring"/, "and draws the composer's own ring");
  assert.doesNotMatch(read("components/settings/ChatSettingsPage.css"), /chat-hold-ring/,
    "no second copy of the ring drifts out of step with the composer's");
});

test("the settings row presents the gesture, its length and the off switch", () => {
  const page = read("components/settings/ChatSettingsPage.tsx");
  assert.match(page, /itemId="chat\.sendHoldDraft"/);
  assert.match(page, /onChange=\{\(sendHoldDraft\) => setUiSettings\(\{ sendHoldDraft \}\)\}/);
  assert.match(page, /ui\.sendHoldDraft && \(/, "the length is only offered while the gesture exists");
  assert.match(page, /itemId="chat\.sendHoldDuration"/);
  assert.match(page, /setUiSettings\(\{ sendHoldDraftMs \}\)/);
  assert.match(page, /settings\.chatPage\.sendHoldSummary/);
  assert.match(page, /settings\.chatPage\.sendHoldSummaryOff/);
  const field = read("components/settings/SendHoldField.tsx");
  assert.match(field, /min=\{SEND_HOLD_MIN_MS\}/);
  assert.match(field, /max=\{SEND_HOLD_MAX_MS\}/);
  assert.match(field, /step=\{SEND_HOLD_STEP_MS\}/);
  assert.match(field, /aria-hidden="true"[\s\S]*?chat-hold-caption/,
    "the specimen is decorative; the track announces the value");
});

test("the chat settings model and search know both new rows", async () => {
  const { CHAT_ROW_ITEMS, chatRowOfItem } = await import("../src/components/settings/chatSettingsModel.ts");
  assert.equal(chatRowOfItem("chat.sendHoldDraft"), "send");
  assert.equal(chatRowOfItem("chat.sendHoldDuration"), "send");
  assert.ok(CHAT_ROW_ITEMS.send.includes("chat.sendHoldDraft"));
  assert.ok(CHAT_ROW_ITEMS.send.includes("chat.sendHoldDuration"));
  // Temporary row: the Send press trace is copied from here (sendPress.ts).
  assert.equal(chatRowOfItem("chat.sendDiagnostics"), "send");
  assert.equal(UI_DEFAULTS.sendHoldDraft, true);
  assert.equal(UI_DEFAULTS.sendHoldDraftMs, SEND_HOLD_DEFAULT_MS);
});
