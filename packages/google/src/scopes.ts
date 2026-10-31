// Google capabilities and the OAuth scopes that back them. One consent asks
// for every capability the OAuth client may request, and a missing one can be
// added later. Granted scopes come from Google's token response: users may
// untick individual scopes on the consent screen, so a capability is available
// only when the scopes it needs were actually granted.

export const GOOGLE_CAPABILITIES = [
  "gmail.read",
  "gmail.send",
  "gmail.write",
  "calendar.read",
  "calendar.write",
  "drive.file",
  "drive.read",
  "drive.write",
] as const;
export type GoogleCapability = (typeof GOOGLE_CAPABILITIES)[number];

export type GoogleService = "gmail" | "calendar" | "drive";

const SCOPE = "https://www.googleapis.com/auth/";

export const IDENTITY_SCOPES = ["openid", "email", "profile"] as const;

interface CapabilitySpec {
  service: GoogleService;
  /** Scopes requested when the user authorizes this capability. */
  request: readonly string[];
  /** The capability is granted when every group has at least one granted scope. */
  satisfiedBy: readonly (readonly string[])[];
}

const GMAIL_FULL = "https://mail.google.com/";

export const CAPABILITY_SPECS: Readonly<Record<GoogleCapability, CapabilitySpec>> = {
  "gmail.read": {
    service: "gmail",
    request: [`${SCOPE}gmail.readonly`],
    satisfiedBy: [[`${SCOPE}gmail.readonly`, `${SCOPE}gmail.modify`, GMAIL_FULL]],
  },
  // New messages only: no access to the mailbox, so no replies, forwards or
  // drafts (those need gmail.write).
  "gmail.send": {
    service: "gmail",
    request: [`${SCOPE}gmail.send`],
    satisfiedBy: [[`${SCOPE}gmail.send`, `${SCOPE}gmail.compose`, `${SCOPE}gmail.modify`, GMAIL_FULL]],
  },
  // gmail.modify covers reading, drafts, sending, labels and trash; it never
  // permits permanent deletion.
  "gmail.write": {
    service: "gmail",
    request: [`${SCOPE}gmail.modify`],
    satisfiedBy: [[`${SCOPE}gmail.modify`, GMAIL_FULL]],
  },
  "calendar.read": {
    service: "calendar",
    request: [`${SCOPE}calendar.readonly`],
    satisfiedBy: [[`${SCOPE}calendar.readonly`, `${SCOPE}calendar`]],
  },
  // calendar.events writes events on every calendar the user can edit
  // (including RSVPs on invitations) without calendar-administration rights.
  "calendar.write": {
    service: "calendar",
    request: [`${SCOPE}calendar.readonly`, `${SCOPE}calendar.events`],
    satisfiedBy: [[`${SCOPE}calendar.events`, `${SCOPE}calendar`]],
  },
  // Only files Polyth creates, or that the user opens or picks with it.
  "drive.file": {
    service: "drive",
    request: [`${SCOPE}drive.file`],
    satisfiedBy: [[`${SCOPE}drive.file`, `${SCOPE}drive`]],
  },
  "drive.read": {
    service: "drive",
    request: [`${SCOPE}drive.readonly`],
    satisfiedBy: [[`${SCOPE}drive.readonly`, `${SCOPE}drive`]],
  },
  "drive.write": {
    service: "drive",
    request: [`${SCOPE}drive`],
    satisfiedBy: [[`${SCOPE}drive`]],
  },
};

export const isGoogleCapability = (value: unknown): value is GoogleCapability =>
  typeof value === "string" && (GOOGLE_CAPABILITIES as readonly string[]).includes(value);

/** Parse Google's space-delimited `scope` string. */
export function parseScopes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(/\s+/).filter(Boolean))].sort();
}

export function grantedCapabilities(scopes: readonly string[]): GoogleCapability[] {
  const granted = new Set(scopes);
  return GOOGLE_CAPABILITIES.filter((capability) =>
    CAPABILITY_SPECS[capability].satisfiedBy.every((group) => group.some((scope) => granted.has(scope))));
}

/**
 * What Polyth's built-in Google app asks for. It stays within Google's
 * sensitive and non-sensitive scopes, so the app passes Google's review
 * without the annual security assessment that restricted scopes (reading
 * mail, the whole Drive) require; those need the deployment's own client.
 */
export const BUILTIN_CLIENT_CAPABILITIES: readonly GoogleCapability[] = ["calendar.read", "calendar.write", "gmail.send", "drive.file"];

/** What one consent asks for with the deployment's own client. */
export const OWN_CLIENT_CAPABILITIES: readonly GoogleCapability[] = ["gmail.read", "gmail.write", "calendar.read", "calendar.write", "drive.read", "drive.write"];

/** Scopes for an authorization that keeps everything already granted and adds
 * the requested capabilities. Google does not support incremental
 * authorization for installed apps, so every request carries the full union.
 * `allowed` drops granted scopes the current client may not request (a grant
 * made through another client can hold more). */
export function scopesForRequest(granted: readonly string[], capabilities: readonly GoogleCapability[], allowed?: readonly GoogleCapability[]): string[] {
  const permitted = allowed && new Set(allowed.flatMap((capability) => CAPABILITY_SPECS[capability].request));
  const scopes = new Set<string>([...IDENTITY_SCOPES, ...granted.filter((scope) => !permitted || permitted.has(scope))]);
  for (const capability of capabilities) {
    for (const scope of CAPABILITY_SPECS[capability].request) scopes.add(scope);
  }
  return [...scopes].sort();
}
