// Cold-boot waterfall fix: auth status and locale loading start in parallel,
// while the authenticated account namespace is restored before the app graph
// evaluates account-scoped browser preferences.
import type { BrowserAuthStatus } from "./authBootstrap.ts";
import { fetchAuthStatus } from "./authClient.ts";
import { setActiveBrowserAccount } from "./accountStorage.ts";

let inflight: Promise<BrowserAuthStatus> | null = null;
let accountScopeResolved = false;

export function isBrowserAccountScopeResolved(): boolean {
  return accountScopeResolved;
}

/** Record an account identity learned from an authenticated server response.
 * Remembered browser state alone is never enough to unlock persistent records. */
export function acceptAuthenticatedBrowserAccount(accountId: string): void {
  setActiveBrowserAccount(accountId);
  accountScopeResolved = true;
}

export function prefetchAuthStatus(): Promise<BrowserAuthStatus> {
  if (inflight) return inflight;
  inflight = fetchAuthStatus().then(async (status) => {
    if (status.authorized) {
      // Account listing is protected; anonymous auth status never reveals
      // which users exist on the server. A remembered cookie can safely use
      // this endpoint to restore the browser-local account namespace.
      const accountsResponse = await fetch("/api/auth/accounts");
      if (!accountsResponse.ok) throw new Error("Authenticated account scope is unavailable");
      const state = await accountsResponse.json() as { currentAccountId?: unknown };
      if (typeof state.currentAccountId !== "string" || !state.currentAccountId.trim()) {
        throw new Error("Authenticated account scope is missing");
      }
      acceptAuthenticatedBrowserAccount(state.currentAccountId);
    }
    return status;
  });
  // Consumed (and error-handled) by Root; an unconsumed failure must not
  // surface as an unhandled rejection during boot.
  inflight.catch(() => undefined);
  return inflight;
}

/** One-shot: mid-session re-checks go through the shared client. */
export function consumeAuthPrefetch(): Promise<BrowserAuthStatus> | null {
  const p = inflight;
  inflight = null;
  return p;
}
