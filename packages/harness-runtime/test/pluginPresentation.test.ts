import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativePluginMutationResponseDto } from "@polyth/contracts/capability-installations";
import {
  importSummary,
  installableScopes,
  installQuestion,
  outcomeNotice,
  parsePluginOptions,
  scopeHint,
} from "../widgets/pluginPresentation.ts";

const confirmed = (over: Partial<NativePluginMutationResponseDto> = {}): NativePluginMutationResponseDto =>
  ({ outcome: "confirmed", operationId: "o", pendingRestart: false, ...over });
const alpha = { id: "p1", name: "Alpha", path: "/work/alpha" };

test("a confirmed outcome carries the harness's own message", () => {
  assert.deepEqual(outcomeNotice("install", "github@openai", confirmed({ message: "Authorize these apps in Codex: GitHub, Linear" }), "next-session"), {
    tone: "success",
    text: "Installed github@openai. Authorize these apps in Codex: GitHub, Linear. New conversations use the change.",
  });
  assert.equal(outcomeNotice("install", "npm:pkg", confirmed({ message: "Installed npm:pkg." }), "next-session").text,
    "Installed npm:pkg. Installed npm:pkg. New conversations use the change.");
  assert.equal(outcomeNotice("update", "lint", confirmed({ message: "   " }), "next-session").text, "Updated lint. New conversations use the change.");
});

test("the restart sentence follows pendingRestart, and nothing-changed never claims an install or a restart", () => {
  assert.equal(outcomeNotice("install", "lint", confirmed({ pendingRestart: true }), "runtime-restart").text, "Installed lint. Restart the runtime to apply it.");
  assert.equal(outcomeNotice("install", "lint", confirmed({ pendingRestart: true }), "next-session").text, "Installed lint. Restart the runtime to apply it.");
  assert.equal(outcomeNotice("install", "lint", confirmed(), "runtime-restart").text, "Installed lint.");
  const unchanged = outcomeNotice("install", "opencode-x", confirmed({ message: "opencode-x is already in the config; nothing changed" }), "runtime-restart");
  assert.deepEqual(unchanged, { tone: "success", text: "opencode-x: opencode-x is already in the config; nothing changed." });
  assert.doesNotMatch(unchanged.text, /Installed|Restart/);
  assert.doesNotMatch(outcomeNotice("install", "x", confirmed({ message: "Nothing changed." }), "next-session").text, /New conversations/);
});

test("project scopes need a named project and name it in hints and the install question", () => {
  assert.deepEqual(installableScopes(["user", "project", "local"], undefined), ["user"]);
  assert.deepEqual(installableScopes(["user", "project", "local"], alpha), ["user", "project", "local"]);
  assert.equal(scopeHint("project", alpha), "Only project Alpha (/work/alpha), shared with the repository");
  assert.equal(scopeHint("local", alpha), "Only project Alpha (/work/alpha), only on this machine");
  assert.equal(scopeHint("user", alpha), "Every project on this machine");
  assert.equal(installQuestion("lint@m", "project", alpha, false), "Install lint@m for project Alpha (/work/alpha)?");
  assert.equal(installQuestion("lint@m", "local", alpha, false), "Install lint@m for project Alpha (/work/alpha), only on this machine?");
  assert.equal(installQuestion("lint@m", "user", alpha, true), "Install lint@m for user scope with the options you entered?");
  assert.equal(installQuestion("lint@m", undefined, undefined, false), "Install lint@m?");
});

test("install options must be one JSON object up to 16 KB; the error never repeats the value", () => {
  assert.deepEqual(parsePluginOptions("  "), {});
  assert.deepEqual(parsePluginOptions('{"apiKey": "s3cret", "n": 1}'), { options: { apiKey: "s3cret", n: 1 } });
  for (const text of ['["s3cret"]', '"s3cret"', "null", "1", "{s3cret}"]) {
    const { error, options } = parsePluginOptions(text);
    assert.equal(options, undefined, text);
    assert.ok(error && !error.includes("s3cret"), text);
  }
  assert.match(parsePluginOptions(JSON.stringify({ blob: "x".repeat(16 * 1024) })).error ?? "", /16 KB/);
});

test("an import summary lists every attempted entry and says where it stopped", () => {
  const all = importSummary([
    { spec: "a", response: confirmed() },
    { spec: "b", response: confirmed({ message: "b is already in the config; nothing changed" }) },
  ], 2, "next-session");
  assert.equal(all.tone, "success");
  assert.equal(all.text, "Installed 2 of 2 plugins. New conversations use the changes.");
  assert.deepEqual(all.details, ["a — Installed.", "b — b is already in the config; nothing changed."]);
  assert.equal(importSummary([{ spec: "a", response: confirmed({ pendingRestart: true }) }], 1, "runtime-restart").text,
    "Installed 1 of 1 plugin. Restart the runtime to apply them.");

  const mixed = importSummary([
    { spec: "a", response: confirmed() },
    { spec: "b", response: { outcome: "rejected", operationId: "o", code: "native-command-failed", message: "no such package", pendingRestart: false } },
    { spec: "c", failure: { tone: "error", text: "Plugin reference is too long." } },
  ], 3, "next-session");
  assert.equal(mixed.tone, "error");
  assert.equal(mixed.text, "Installed 1 of 3 plugins. New conversations use the changes.");
  assert.deepEqual(mixed.details?.slice(1), ["b — Nothing changed: no such package", "c — Plugin reference is too long."]);

  const stopped = importSummary([
    { spec: "a", response: confirmed() },
    { spec: "b", response: { outcome: "unknown", operationId: "o", pendingRestart: false } },
  ], 4, "next-session");
  assert.equal(stopped.tone, "warning");
  assert.equal(stopped.text, "Installed 1 of 4 plugins. New conversations use the changes. Stopped at b because its result is not confirmed; 2 not tried. Check the list before trying again.");
});
