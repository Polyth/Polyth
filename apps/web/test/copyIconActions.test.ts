import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("copy and chat actions use a transient green check without visible status text", async () => {
  const [copy, timeline, messageActions, responseFooter, actionBar, css] = await Promise.all([
    readFile(new URL("../src/components/CopyButton.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/Timeline.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/MessageQuickActions.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ChatResponseFooter.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/MessageActionBar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ChatChrome.css", import.meta.url), "utf8"),
  ]);

  assert.match(copy, /label = tr\("copybutton\.copyToClipboard"\)/);
  assert.match(copy, /<IconButton/);
  assert.match(copy, /icon=\{done \? CopiedIcon : CopyIcon\}/);
  assert.match(copy, /label=\{actionLabel\}/);
  assert.match(copy, /title=\{actionLabel\}/);
  assert.doesNotMatch(copy, /<button/);

  assert.match(timeline, /<MessageQuickActions/);
  assert.match(timeline, /<ChatResponseFooter/);
  assert.match(timeline, /className="msg-live sr-only"/);
  // Both roles confirm through the shared bar: the invoking glyph (or the
  // More trigger for a menu action) turns into a check for one second.
  assert.match(messageActions, /useActionConfirmation\(\)/);
  assert.match(responseFooter, /useActionConfirmation\(\)/);
  assert.match(actionBar, /icon=\{isConfirmed \? CheckIcon : action\.icon\}/);
  assert.match(actionBar, /icon=\{menuConfirmed \? CheckIcon : MoreIcon\}/);
  assert.match(actionBar, /chat-action-button--confirmed/);
  assert.match(actionBar, /1_000/);
  assert.doesNotMatch(messageActions, /statusText|chat-action-status/);
  assert.doesNotMatch(responseFooter, /statusText|chat-action-status/);
  assert.match(css, /\.chat-action-button\.ui-icon-btn\.chat-action-button--confirmed[\s\S]*?color:\s*var\(--green\)/s);
  assert.match(css, /@keyframes chat-action-check-pop/);
  assert.doesNotMatch(css, /\.chat-action-status\s*\{/);
});
