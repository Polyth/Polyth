import test from "node:test";
import assert from "node:assert/strict";
import type { CanonicalSecurity } from "../src/canonicalSecurity.ts";
import {
  bindCanonicalSecurityFactory,
  canonicalSecurity,
} from "../src/runtimeSecurity.ts";

test("canonical authority factory stays lazy and materializes exactly once", t => {
  let calls = 0;
  const authority = { marker: "canonical" } as unknown as CanonicalSecurity;
  const binding = bindCanonicalSecurityFactory(() => {
    calls += 1;
    return authority;
  });
  t.after(() => binding.dispose());

  assert.equal(calls, 0);
  assert.equal(canonicalSecurity(), authority);
  assert.equal(calls, 1);
  assert.equal(canonicalSecurity(), authority);
  assert.equal(calls, 1);

  binding.dispose();
  assert.equal(canonicalSecurity(), null);
});

test("disposing an unused factory never invokes it", () => {
  let calls = 0;
  const binding = bindCanonicalSecurityFactory(() => {
    calls += 1;
    return {} as CanonicalSecurity;
  });
  binding.dispose();
  assert.equal(calls, 0);
  assert.equal(canonicalSecurity(), null);
});
