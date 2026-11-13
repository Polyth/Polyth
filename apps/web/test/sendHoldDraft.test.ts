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
  const canPark = composer.slice(composer.indexOf("canParkRef.current = () =>"), composer.indexOf("const holdRef = useRef"));
  assert.match(canPark, /sendHoldRef\.current > 0/, "an off gesture can never park a message");
  const startHold = composer.slice(composer.indexOf("const startHold = useCallback"), composer.indexOf("const onPrimaryPointerDown"));
  assert.match(startHold, /const holdMs = sendHoldRef\.current;\n\s*if \(holdMs <= 0 \|\| !canParkRef\.current\(\)\) return;/,
    "an off gesture starts no ring and no timer");
  assert.match(startHold, /\}, holdMs\);/, "the timer is the person's length");
  assert.doesNotMatch(composer, /SEND_HOLD_MS/, "no hardcoded hold survives in the composer");
});

test("the ring is drawn for the chosen length, and its hint disappears when the gesture is off", () => {
  const composer = read("components/Composer.tsx");
  assert.match(composer, /"--send-hold-ms": `\$\{sendHoldRef\.current\}ms`/,
    "the button publishes the length it is waiting for");
  assert.match(composer, /const holdHint = uiPrefs\.sendHoldDraft \? ` · \$\{tr\("composer\.holdToSaveDraft"\)\}` : "";/,
    "a disabled gesture promises nothing in the tooltip");
  const styles = read("styles.css");
  assert.match(styles, /animation: send-hold-fill var\(--send-hold-ms, 500ms\) linear forwards;/);
  assert.match(styles, /transition: transform var\(--send-hold-ms, 500ms\) var\(--motion-ease\);/);
  assert.doesNotMatch(styles, /send-hold-fill 500ms linear/);
  assert.match(composer, /className="send-hold-ring"[\s\S]*?className="send-hold-ring"/,
    "the running delivery button draws the same ring as idle Send");
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
  assert.equal(UI_DEFAULTS.sendHoldDraft, true);
  assert.equal(UI_DEFAULTS.sendHoldDraftMs, SEND_HOLD_DEFAULT_MS);
});
