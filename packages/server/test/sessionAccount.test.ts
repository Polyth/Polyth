import test from "node:test";
import assert from "node:assert/strict";
import { resolveSessionAccount } from "../src/sessionAccount.ts";

const space = (members: string[]) => ({
  members: () => members,
  isMember: (userId: string) => members.includes(userId),
});

test("a chat's recorded owner decides whose settings apply", () => {
  assert.equal(resolveSessionAccount({ recipient: "ann", actor: "bea", ...space(["ann", "bea"]) }), "ann");
});

test("without a recorded owner the person the chat acts for applies, only while a member", () => {
  assert.equal(resolveSessionAccount({ actor: "bea", ...space(["ann", "bea"]) }), "bea");
  // Bea left the Space: her settings no longer apply, and two members remain.
  assert.equal(resolveSessionAccount({ actor: "bea", ...space(["ann", "cy"]) }), undefined);
});

test("a Space's only member owns a chat nobody wrote to; a shared Space has no default owner", () => {
  assert.equal(resolveSessionAccount({ ...space(["ann"]) }), "ann");
  assert.equal(resolveSessionAccount({ actor: "gone", ...space(["ann"]) }), "ann");
  assert.equal(resolveSessionAccount({ ...space(["ann", "bea"]) }), undefined);
  assert.equal(resolveSessionAccount({ ...space([]) }), undefined);
});
