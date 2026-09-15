import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");

test("Composer lets only host-only extension commands bypass model/profile admission", () => {
  assert.match(source, /noModels && !hostOnlyExtensionCommand/);
  assert.match(source, /profileMissing && !hostOnlyExtensionCommand/);
  assert.match(source, /\(noModels \|\| profileMissing\) && !hostOnlyExtensionCommandReady/);
  assert.match(source, /isHostOnlyExtensionCommand\(selectedNativeCommand\)\s*&& attachments\.length === 0/);
});
