import type { Disposable } from "@polyth/contracts";
import type { CanonicalSecurity } from "./canonicalSecurity.ts";

let active: CanonicalSecurity | null = null;

/**
 * Process-local composition seam. The bootstrap owns the canonical authority;
 * legacy-shaped adapters may consume it, but may never create or replace it.
 */
export function bindCanonicalSecurity(security: CanonicalSecurity): Disposable {
  if (active && active !== security) {
    throw Object.assign(new Error("canonical security authority is already bound"), { code: "conflict" });
  }
  active = security;
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (active === security) active = null;
    },
  };
}

export function canonicalSecurity(): CanonicalSecurity | null {
  return active;
}
