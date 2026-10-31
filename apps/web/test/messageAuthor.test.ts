import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionEvent } from "@polyth/contracts";
import { buildModel, type UserMsg } from "../src/reduce.ts";
import { userArticleNameFrom } from "../src/messageActions.ts";

const event = (seq: number, type: string, data: JsonObject): SessionEvent => ({
  id: String(seq), sessionId: "shared", seq, time: seq, type, data, v: 1,
});

test("a prompt in a shared session keeps who wrote it; malformed or absent authors stay unlabeled", () => {
  const users = buildModel([
    event(1, "user/message", { text: "from before authorship" }),
    event(2, "user/message", { text: "Bea asks", author: { userId: "usr_bea", name: "Bea", role: "admin" } }),
    event(3, "user/message", { text: "forged", author: { name: "no id" } }),
  ]).messages.filter((message): message is UserMsg => message.kind === "user");
  assert.deepEqual(users.map((message) => message.author), [undefined, { userId: "usr_bea", name: "Bea" }, undefined]);
});

test("someone else's prompt is announced with their name", () => {
  assert.match(userArticleNameFrom("Bea", Date.UTC(2026, 9, 13, 9, 30)), /^Message from Bea sent at /);
});
