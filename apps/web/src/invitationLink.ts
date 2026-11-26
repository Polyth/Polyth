// An invitation link is `<origin>/#invite=<code>`. The code rides in the
// fragment so it never reaches a server log, a proxy or a Referer header. It
// is taken out of the address bar before anything renders, kept in this tab's
// sessionStorage so a reload mid-way still finds it, and dropped once used.

const KEY = "polyth.invitationCode";
const CODE = /^pinv_[A-Za-z0-9_-]{20,128}$/;

/** The code an `#invite=` fragment carries, if it is well formed. */
export function invitationCodeFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const value = new URLSearchParams(raw).get("invite");
  return value && CODE.test(value) ? value : null;
}

/** Shareable link for a code, at the address the server named or else this page's. */
export function invitationUrl(serverUrl: string, pageOrigin: string, isShareable: (origin: string) => string | null): string | null {
  let parsed: URL;
  try { parsed = new URL(serverUrl); } catch { return null; }
  const code = invitationCodeFromHash(parsed.hash);
  if (!code) return null;
  const origin = isShareable(parsed.origin) ?? isShareable(pageOrigin);
  return origin ? `${origin}/#invite=${code}` : null;
}

/** Called once at boot: moves a fragment code into this tab and cleans the address bar. */
export function takeInvitationCode(): string | null {
  if (typeof location === "undefined") return null;
  const fromHash = invitationCodeFromHash(location.hash);
  if (fromHash) {
    try { sessionStorage.setItem(KEY, fromHash); } catch { /* private mode: this load still has it */ }
    try { history.replaceState(history.state, "", `${location.pathname}${location.search}`); } catch { /* keep going */ }
    return fromHash;
  }
  try {
    const stored = sessionStorage.getItem(KEY);
    return stored && CODE.test(stored) ? stored : null;
  } catch { return null; }
}

export function forgetInvitationCode(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* nothing kept */ }
}
