import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Disposable } from "@polyth/contracts";
import type { CanonicalSecurity } from "./canonicalSecurity.ts";

let active: CanonicalSecurity | null = null;
let pendingFactory: (() => CanonicalSecurity) | null = null;
let factoryProduct: CanonicalSecurity | null = null;
let creating = false;

const conflict = (): Error => Object.assign(
  new Error("canonical security authority is already bound"),
  { code: "conflict" },
);

const internalCoreEntry = resolve(fileURLToPath(new URL("./indexCore.ts", import.meta.url)));

/** The internal composition root is importable for tests/composition, but it is
 * not a supported executable. Direct execution would otherwise start the old
 * auth/tenancy compatibility path without canonical preflight. */
export function isDirectInternalCoreEntrypoint(entry = process.argv[1]): boolean {
  return typeof entry === "string" && entry.length > 0 && resolve(entry) === internalCoreEntry;
}

const canonicalEntrypointRequired = (): Error => Object.assign(
  new Error("indexCore is internal; start Polyth through packages/server/src/index.ts"),
  { code: "canonical-entrypoint-required" },
);

/**
 * Process-local composition seam. The bootstrap owns the canonical authority;
 * legacy-shaped adapters may consume it, but may never create or replace it.
 */
export function bindCanonicalSecurity(security: CanonicalSecurity): Disposable {
  if ((active && active !== security) || pendingFactory) throw conflict();
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

/**
 * Ready-runtime bootstrap seam. The factory is synchronous on purpose: it is
 * first consumed by createAuthService/createSpaceGateway after indexCore has
 * acquired the OS writer lease, so opening/migrating control.sqlite cannot race
 * another Polyth writer. The bootstrap still owns closing the produced object.
 */
export function bindCanonicalSecurityFactory(factory: () => CanonicalSecurity): Disposable {
  if (active || pendingFactory) throw conflict();
  pendingFactory = factory;
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (pendingFactory === factory) pendingFactory = null;
      if (factoryProduct && active === factoryProduct) active = null;
      factoryProduct = null;
    },
  };
}

export function canonicalSecurity(): CanonicalSecurity | null {
  if (active) return active;
  const factory = pendingFactory;
  if (!factory) {
    if (isDirectInternalCoreEntrypoint()) throw canonicalEntrypointRequired();
    return null;
  }
  if (creating) throw conflict();
  creating = true;
  try {
    const produced = factory();
    if (active && active !== produced) throw conflict();
    active = produced;
    factoryProduct = produced;
    // Keep the factory marker until disposal so a direct bind cannot replace
    // the lazily-created authority while its bootstrap still owns it.
    return produced;
  } finally {
    creating = false;
  }
}
