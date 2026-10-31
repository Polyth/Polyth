// Cold-boot waterfall fix: auth status and locale loading start in parallel,
// while the authenticated account namespace is restored before the app graph
// evaluates account-scoped browser preferences.
import { resetGuardrails } from "./guardrails.ts";
import { validateAuthStatus, type BrowserAuthStatus } from "./authBootstrap.ts";
import { fetchAuthStatus } from "./authClient.ts";
import { setActiveBrowserAccount } from "./accountStorage.ts";
import { completePendingProviderCallback, hasPendingProviderCallback } from "./identityProviders.ts";

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
  resetGuardrails(); // the next consumer reloads the new account's guardrails
}

/** A shell on a loopback HTTP origin: Polyth Link's local proxy (the phone and
 * desktop apps) or a server on this machine. Only there do the `local-user`
 * and `paired-device` scopes, and the proxy's client-context endpoint, occur. */
export function isLoopbackShellOrigin(where: Pick<Location, "protocol" | "hostname">): boolean {
  return where.protocol === "http:" && (where.hostname === "127.0.0.1" || where.hostname === "localhost");
}

/** The status the server inlined into this HTML shell (current servers,
 * browser ingress), read once: a later check must ask the server again.
 * Malformed or absent → null, and boot asks `/api/auth/status` as before. */
export function takeEmbeddedAuthStatus(): BrowserAuthStatus | null {
  if (typeof document === "undefined") return null;
  const element = document.getElementById("polyth-auth-status");
  if (!element) return null;
  element.remove();
  try {
    return validateAuthStatus(JSON.parse(element.textContent ?? ""));
  } catch {
    return null;
  }
}

export function prefetchAuthStatus(): Promise<BrowserAuthStatus> {
  if (inflight) return inflight;
  // Those scopes resolve identity through the Space gateway. Ask it alongside
  // the status instead of one round trip later; other scopes drop the answer.
  const spaces = typeof location !== "undefined" && isLoopbackShellOrigin(location)
    ? fetch("/api/spaces").catch(() => null)
    : null;
  inflight = (async () => {
    if (hasPendingProviderCallback()) {
      try {
        const completed = await completePendingProviderCallback();
        window.location.replace(completed.returnTo);
        // Do not let the old callback document boot packages while navigation
        // to the clean return path is still pending.
        return await new Promise<BrowserAuthStatus>(() => undefined);
      } catch (error) {
        console.warn("[polyth] identity provider callback failed", error);
        window.history.replaceState(null, "", "/");
      }
    }
    return takeEmbeddedAuthStatus() ?? await fetchAuthStatus();
  })().then(async (status) => {
    if (status.authorized) {
      // A local-user status proves trusted loopback reachability, and a
      // paired-device status a Link device grant, not a human UI session.
      // Resolve their identity only through the authorized Space gateway,
      // which returns the user bound to the validated SpaceContext (paired
      // devices may not reach /api/auth/accounts at all). Cookie-backed UI
      // sessions retain the account-management endpoint.
      const viaSpaces = status.scope === "local-user" || status.scope === "paired-device";
      // A current server names the UI session's own account in the status
      // answer: the account-management read would only repeat it.
      if (!viaSpaces && status.scope === "ui-session" && status.accountId) {
        acceptAuthenticatedBrowserAccount(status.accountId.trim());
        return status;
      }
      const early = viaSpaces ? await spaces : null;
      const identityResponse = early?.ok ? early : await fetch(viaSpaces ? "/api/spaces" : "/api/auth/accounts");
      if (!identityResponse.ok) throw new Error("Authenticated account scope is unavailable");
      const state = await identityResponse.json() as {
        user?: { id?: unknown };
        currentAccountId?: unknown;
      };
      const accountId = viaSpaces ? state.user?.id : state.currentAccountId;
      if (typeof accountId !== "string" || !accountId.trim()) {
        throw new Error("Authenticated account scope is missing");
      }
      acceptAuthenticatedBrowserAccount(accountId.trim());
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
