// `session.code.actions`: the host mounts package contributions in a code
// fence header only for a completed block whose language the action lists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerSlot } from "../src/slots.ts";
import { codeBlockActionChildren } from "../src/markdown/codeBlockActions.ts";

test("code block actions mount for listed languages and never while streaming", () => {
  const off = registerSlot("session.code.actions", "test.run", () => null, 10, { codeAction: { languages: ["sh", "bash"] } });
  const any = registerSlot("session.code.actions", "test.any", () => null, 20);
  try {
    const ctx = { lang: "bash", text: "ls", streaming: false, sessionId: "s1" };
    assert.deepEqual(codeBlockActionChildren(ctx).map((node) => (node as { key: string }).key), ["test.run", "test.any"]);
    assert.deepEqual(codeBlockActionChildren({ ...ctx, lang: "python" }).map((node) => (node as { key: string }).key), ["test.any"]);
    assert.equal(codeBlockActionChildren({ ...ctx, streaming: true }).length, 0);
    assert.equal(codeBlockActionChildren({ ...ctx, lang: "" }).length, 0);
  } finally { off(); any(); }
});
