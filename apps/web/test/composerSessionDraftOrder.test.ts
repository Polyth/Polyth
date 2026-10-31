// Packet C3: the session-switch effect must commit the incoming draft and
// per-session config in the layout phase, so the first painted frame of a
// switch is the newcomer's draft instead of the outgoing session's text (which
// is what produced the one-frame text jump / cross-session draft leak). The
// outgoing flush stays first in that same effect and runs exactly once.
//
// No existing test mounts Composer (its store/service graph is large), so this
// pins the source order rather than a painted frame. It fails on the pre-fix
// `useEffect` arrangement.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

const MARKER = "const outgoing = sessionIdRef.current;";
// Keyed on the unsent chat's origin, not on the raw intent: a checkout or
// repository choice republishes the intent and must not re-seed the input from
// its stale `draft` (composerIsolationDraft.test.ts mounts that behavior).
const END = "}, [session?.id, newSessionChat, flushComposerDraft]);";

test("the session switch applies the incoming draft before paint and flushes the outgoing one first", async () => {
  const source = await read("../src/components/Composer.tsx");
  const start = source.indexOf(MARKER);
  assert.ok(start > -1, "the session-switch effect is present");
  const end = source.indexOf(END, start);
  assert.ok(end > start, "the session-switch effect keeps its dependency list");

  // The nearest effect opener before the switch body decides the phase.
  const layoutOpen = source.lastIndexOf("useLayoutEffect(() => {", start);
  const passiveOpen = source.lastIndexOf("useEffect(() => {", start);
  assert.ok(layoutOpen > passiveOpen,
    "the session-switch effect is a layout effect, so the incoming draft lands before the browser paints");

  const block = source.slice(start, end);
  const flush = block.indexOf("flushComposerDraft();");
  const applyText = block.indexOf("setText(t);");
  const applyInput = block.indexOf("inputRef.current?.replaceText(t");
  const applyConfig = block.indexOf("setCfg(loadComposerConfig(session?.id ?? null));");
  assert.ok(flush > -1, "the outgoing draft is flushed before the swap");
  assert.ok(applyText > -1 && applyInput > -1 && applyConfig > -1,
    "the incoming draft and per-session config are applied in the same effect");
  assert.ok(flush < applyText && flush < applyInput && flush < applyConfig,
    "the outgoing flush runs before the incoming draft/config is applied");
  assert.equal(block.split("flushComposerDraft();").length - 1, 1,
    "the outgoing draft is flushed exactly once");
});

test("the session switch re-seeds a new chat from its origin, never from a republished intent", async () => {
  const source = await read("../src/components/Composer.tsx");
  assert.match(source, /const newSessionChat = useStore\(\(s\) => newSessionOrigin\(s\.newSessionIntent\)\);/,
    "the composer subscribes to the chat's origin");
  assert.ok(!source.includes("[session?.id, newSessionIntent, flushComposerDraft]"),
    "the effect must not depend on the raw intent: every isolate/repository choice republishes it");
  // The seed still comes from the intent; only the trigger changed.
  const start = source.indexOf(MARKER);
  const end = source.indexOf(END, start);
  assert.ok(start > -1 && end > start);
  assert.ok(source.slice(start, end).includes(": newSessionIntent?.draft ?? \"\";"),
    "a new chat is still seeded from its intent's draft");
});
