// Domain services only. The host must wire the authenticated gateway, secure
// ingress, UI and reviewed legacy migration before enabling account-first mode.
import type { ControlPlane } from '@polyth/control-plane';
import { createPasswordService, type PasswordService } from './passwords.ts';
import { createSessions } from './sessions.ts';
import { createSetup } from './setup.ts';
import { createCredentials } from './credentials.ts';
import { createAccounts } from './accounts.ts';
import { createPasskeys, type WebAuthnConfig } from './passkeys.ts';
export type { IdentityUser, IdentitySession, SessionSummary, SetupStatus } from './types.ts';
export type { CompleteSetup } from './setup.ts';
export type { PasswordService } from './passwords.ts';
export type { WebAuthnConfig, PasskeySummary } from './passkeys.ts';
export { canonicalHttpsIssuer, createProviderFramework, githubDeviceFlowConfigured, githubIdentityAdapter } from './providers/index.ts';
export type {
  IdentityProviderAdapter,
  NormalizedExternalIdentity,
  ProviderCapabilities,
  ProviderConfiguration,
  ProviderNetworkBroker,
  ProviderPurpose,
  ProviderSecretBroker,
  ProviderTransactionStart,
} from './providers/index.ts';

export function createIdentityService(control: ControlPlane, opts: {
  now?: () => number; idleMs?: number; absoluteMs?: number;
  /** Inject only from trusted host composition/tests, never request input. */
  passwords?: PasswordService;
  webauthn?: WebAuthnConfig;
} = {}) {
  const now = opts.now ?? Date.now;
  const passwords = opts.passwords ?? createPasswordService();
  const sessions = createSessions(control, { now, idleMs: opts.idleMs, absoluteMs: opts.absoluteMs });
  const passkeys = createPasskeys(control, sessions, now, opts.webauthn);
  return {
    setup: createSetup(control, passwords, sessions, now, () => passkeys.available()),
    sessions,
    credentials: createCredentials(control, passwords, sessions, now),
    accounts: createAccounts(control, passwords, sessions, now),
    passkeys,
    close() { passwords.close(); }, // DB lifetime belongs to the host.
  };
}
export type IdentityService = ReturnType<typeof createIdentityService>;
