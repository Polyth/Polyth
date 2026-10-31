// Session purposes a package presents in its own UI (an agent's runs live in
// its diary). The ordinary session lists leave those sessions out; opening one
// is unchanged. Claims are reference-counted so a re-registering package never
// drops another registration's claim.
const claims = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
let snapshot: ReadonlySet<string> = new Set();

function publish(): void {
  version += 1;
  snapshot = new Set(claims.keys());
  for (const listener of [...listeners]) listener();
}

export function claimSessionListing(purpose: string): () => void {
  const id = purpose.trim();
  if (!id) return () => {};
  claims.set(id, (claims.get(id) ?? 0) + 1);
  if (claims.get(id) === 1) publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (claims.get(id) ?? 1) - 1;
    if (left > 0) claims.set(id, left);
    else {
      claims.delete(id);
      publish();
    }
  };
}

/** Purposes currently claimed; a stable object between changes. */
export function claimedListingPurposes(): ReadonlySet<string> {
  return snapshot;
}

export function subscribeSessionListing(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function sessionListingVersion(): number {
  return version;
}
