// The microphone is the whole dictation control on every layout: no status
// text, cancel or retry chrome, and listening is the button itself. Moved out
// of apps/web/test/dictationComposer.test.ts so the host test no longer names
// the removable package.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("the microphone is the whole dictation control on every layout", async () => {
  const voice = await read("../widgets/voice.tsx");
  const css = await read("../widgets/styles.css");

  const render = voice.slice(voice.indexOf('<span ref={controlRef} className={`mic-control'));
  assert.doesNotMatch(render, /mic-status|mic-cancel|mic-retry/,
    "no status text, cancel or retry control is drawn beside the mic");
  assert.doesNotMatch(css, /\.mic-status|\.mic-cancel|\.mic-retry/,
    "the removed chrome leaves no styling behind");
  assert.doesNotMatch(voice, /setPartial/,
    "interim text lives in the composer, not in mic-local state");

  // Listening is shown by the button brightening with measured speech.
  assert.match(css, /\.mic-control \.mic-btn\.listening \{[^}]*var\(--mic-speech\)/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?--mic-speech:\s*1;/,
    "reduced motion holds a steady listening state instead of tracking the voice");
  assert.match(voice, /el\.style\.setProperty\("--mic-level", next\)/,
    "the level is written to the DOM so audio chunks never re-render the rail");
  assert.match(voice, /const levelRef = useRef\(0\)/,
    "loudness is a ref, never React state");

  // The lifecycle string still reaches assistive tech even with no visible chip.
  assert.match(voice, /if \(lifecycleStatus !== lastAnnounced\.current\) announce\(lifecycleStatus\)/);
  assert.match(voice, /title=\{detail \?\? action\}/,
    "an unavailable or failed mic still names its reason on demand");
});
