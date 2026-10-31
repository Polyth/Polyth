import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");

test("Composer lets only host-only extension commands bypass model/profile admission", () => {
  // Model admission is the gated absence (a transient route-change load is not
  // an absent engine), never the raw catalogue state.
  assert.match(source, /modelAbsenceBlocksSend && !hostOnlyExtensionCommand/);
  assert.match(source, /profileMissing && !hostOnlyExtensionCommand/);
  assert.match(source, /\(modelAbsenceBlocksSend \|\| profileMissing\) && !hostOnlyCommandReady/);
  assert.match(source, /isHostOnlyExtensionCommand\(selectedNativeCommand\)\s*&& attachments\.length === 0/);
  assert.match(source, /\(isHostOnlyExtensionCommand\(draftNativeCommand\) \|\| draftCompactCommand\)\s*&& attachments\.length === 0/);
});

test("Composer runs /compact as a host action before model admission", () => {
  // The native compaction block is a durable `session/compacted` marker, so the
  // builtin command must call the compact endpoint, never enter the send path.
  const compactBranch = source.slice(
    source.indexOf("isCompactCommand(t, commandCatalog.items"),
    source.indexOf("if (command === null && modelAbsenceBlocksSend"),
  );
  assert.match(compactBranch, /if \(!startCompact\(target\)\) return;/);
  assert.doesNotMatch(compactBranch, /sendMessage\(/);
  // The context card's Compact button shares the same guarded path.
  const startCompact = source.slice(
    source.indexOf("const startCompact = "),
    source.indexOf("return true;", source.indexOf("const startCompact = ")),
  );
  assert.match(startCompact, /compactBlockReason\(/);
  assert.match(startCompact, /api\.compact\(target!\)/);
});
