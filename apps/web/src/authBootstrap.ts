// Browser-safe, explicit authorization. `required: false` is not permission.
import type { AuthStatusDto } from '@polyth/session/web-api';

export type BrowserInstallationState = 'uninitialized' | 'claimed' | 'configuring' | 'ready' | 'recovery';
export interface BrowserAuthStatus extends AuthStatusDto {
  scope: "anonymous" | "local-user" | "ui-session" | "paired-device" | "internal-service";
  state?: BrowserInstallationState;
  methods?: string[];
  csrfToken?: string;
  /** A `ui-session`'s own account (current servers), saving boot a request. */
  accountId?: string;
  bootstrapMode?: 'setup';
  /** `local`: the owner has no password and only Polyth Desktop on that
   *  machine opens this installation. Absent before setup and on older servers. */
  accessMode?: 'local' | 'accounts';
}

export function validateAuthStatus(value: unknown): BrowserAuthStatus {
  if (!value || typeof value !== 'object') throw new Error('Invalid authentication status');
  const status = value as BrowserAuthStatus & { scope?: unknown };
  if (typeof status.required !== 'boolean' || typeof status.authorized !== 'boolean' || typeof status.scope !== 'string'
    || !['anonymous', 'local-user', 'ui-session', 'paired-device', 'internal-service'].includes(status.scope)
    || (status.authorized && !['local-user', 'ui-session', 'paired-device'].includes(status.scope))) {
    throw new Error('Invalid authentication status');
  }
  if (status.state !== undefined && !['uninitialized', 'claimed', 'configuring', 'ready', 'recovery'].includes(status.state)) {
    throw new Error('Invalid installation state');
  }
  if (status.csrfToken !== undefined && !/^[a-f0-9]{64}$/.test(status.csrfToken)) {
    throw new Error('Invalid authentication nonce');
  }
  if (status.accountId !== undefined && (typeof status.accountId !== 'string' || !status.accountId.trim())) {
    throw new Error('Invalid authentication account');
  }
  if (status.bootstrapMode !== undefined && status.bootstrapMode !== 'setup') {
    throw new Error('Invalid bootstrap mode');
  }
  if (status.accessMode !== undefined && status.accessMode !== 'local' && status.accessMode !== 'accounts') {
    throw new Error('Invalid access mode');
  }
  return status;
}

const OWNER_SESSION_RENEW_KEY = 'polyth.desktop.ownerSessionRenewAt';
const OWNER_SESSION_RENEW_WINDOW_MS = 60_000;

/** A locked Polyth Desktop window of a password-less owner asks its main
 * process for a fresh owner session — at most once per window, so a shell that
 * cannot provide one shows the lock screen instead of reloading forever. */
export function claimOwnerSessionRenewal(
  status: Pick<BrowserAuthStatus, 'accessMode' | 'authorized'>,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  now = Date.now(),
): boolean {
  if (status.authorized || status.accessMode !== 'local') return false;
  if (now - Number(storage.getItem(OWNER_SESSION_RENEW_KEY) ?? 0) < OWNER_SESSION_RENEW_WINDOW_MS) return false;
  storage.setItem(OWNER_SESSION_RENEW_KEY, String(now));
  return true;
}

export function authBootstrapPhase(status: unknown): 'setup' | 'restart' | 'locked' | 'ready' | 'unavailable' {
  const value = validateAuthStatus(status);
  if (value.state === 'recovery') return 'unavailable';
  if (value.bootstrapMode === 'setup' && value.state === 'ready') return 'restart';
  if (value.bootstrapMode === 'setup' || (value.state && value.state !== 'ready')) return 'setup';
  return value.authorized ? 'ready' : 'locked';
}

const LINK_SESSION_BOUNCE_KEY = 'polyth.link.sessionBounceAt';
const LINK_SESSION_BOUNCE_WINDOW_MS = 60_000;

/** A Polyth Link loopback proxy answers 401 when this WebView lost its proxy
 * session, which the connection hub restores with a fresh bootstrap. Bounce at
 * most once per window so a WebView that still withholds the session lands on
 * the error screen instead of looping. */
export function claimLinkSessionBounce(
  error: unknown,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  now = Date.now(),
): boolean {
  if ((error as { status?: unknown } | null)?.status !== 401) return false;
  if (now - Number(storage.getItem(LINK_SESSION_BOUNCE_KEY) ?? 0) < LINK_SESSION_BOUNCE_WINDOW_MS) return false;
  storage.setItem(LINK_SESSION_BOUNCE_KEY, String(now));
  return true;
}
