// Cold-boot waterfall fix: the auth-status round-trip is independent of the
// locale catalog and the bootstrap chunk, so main.tsx starts it before the
// app graph downloads and Root consumes the already-in-flight promise instead
// of paying a serial fetch after first render.
import type { AuthStatusDto } from "@polyth/session/web-api";

let inflight: Promise<AuthStatusDto> | null = null;

export function prefetchAuthStatus(): void {
  if (inflight) return;
  inflight = fetch("/api/auth/status").then(async (res) => {
    if (!res.ok) throw new Error(`auth status: HTTP ${res.status}`);
    return await res.json() as AuthStatusDto;
  });
  // Consumed (and error-handled) by Root; an unconsumed failure must not
  // surface as an unhandled rejection during boot.
  inflight.catch(() => undefined);
}

/** One-shot: mid-session re-checks go through api.authStatus() as before. */
export function consumeAuthPrefetch(): Promise<AuthStatusDto> | null {
  const p = inflight;
  inflight = null;
  return p;
}
