import { test } from "node:test";
import assert from "node:assert/strict";
import { REMOTE_CAPABILITY } from "@polyth/contracts";
import { grantsForProfile } from "../src/index.ts";

test("interactive pairing profiles include dictation while observe remains read-only", () => {
  assert.equal(grantsForProfile("observe").includes(REMOTE_CAPABILITY.dictationUse), false);
  for (const profile of ["interact", "developer", "full-remote"] as const) {
    const grants = grantsForProfile(profile);
    assert.equal(grants.includes(REMOTE_CAPABILITY.coreSessionsRead), true);
    assert.equal(grants.includes(REMOTE_CAPABILITY.dictationUse), true, profile);
    assert.equal(grants.filter((grant) => grant === REMOTE_CAPABILITY.dictationUse).length, 1, profile);
  }
});
