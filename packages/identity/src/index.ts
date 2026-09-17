// Domain services only. The host must wire the authenticated gateway, secure
// ingress, UI and reviewed legacy migration before enabling account-first mode.
import type { ControlPlane } from '@polyth/control-plane';
import { createPasswordService, type PasswordService } from './passwords.ts';
import { createSessions } from './sessions.ts';
import { createSetup } from './setup.ts';
import { createCredentials } from './credentials.ts';
import { createAccounts } from './accounts.ts';
import { createPasskeys, type WebAuthnConfig } from './passkeys.ts';
import { createIdentityLinks } from './links.ts';
import {
  createProviderFramework,
  type IdentityProviderAdapter,
  type ProviderNetworkBroker,
  type ProviderSecretBroker,
} from './providers/index.ts';

export type { IdentityUser, IdentitySession, SessionSummary, SetupStatus } from './types.ts';
export type { CompleteSetup } from './setup.ts';
export type { PasswordService } from './passwords.ts';
export type { WebAuthnConfig, PasskeySummary } from './passkeys.ts';
export { createIdentityLinks } from './links.ts';
export type { LinkedIdentitySummary, ProviderFramework } from './links.ts';
export {
  bitbucketIdentityAdapter,
  canonicalHttpsIssuer,
  createGitLabIdentityAdapter,
  createProviderFramework,
  githubDeviceFlowConfigured,
  githubIdentityAdapter,
} from './providers/index.ts';
export type {
  GitLabOidcVerifier,
  GitLabOidcVerificationInput,
  IdentityProviderAdapter,
  NormalizedExternalIdentity,
  ProviderCapabilities,
  ProviderConfiguration,
  ProviderNetworkBroker,
  ProviderPurpose,
  ProviderSecretBroker,
  ProviderTransactionStart,
} from './providers/index.ts';

export interface IdentityProviderHost {
  adapters: IdentityProviderAdapter[];
  secrets: ProviderSecretBroker;
  network: ProviderNetworkBroker;
}

export function createIdentityService(control: ControlPlane, opts: {
  now?: () => number; idleMs?: number; absoluteMs?: number;
  /** Inject only from trusted host composition/tests, never request input. */
  passwords?: PasswordService;
  webauthn?: WebAuthnConfig;
  providers?: IdentityProviderHost;
} = {}) {
  const now = opts.now ?? Date.now;
  const passwords = opts.passwords ?? createPasswordService();
  const sessions = createSessions(control, { now, idleMs: opts.idleMs, absoluteMs: opts.absoluteMs });
  const passkeys = createPasskeys(control, sessions, now, opts.webauthn);
  const providers = opts.providers
    ? createProviderFramework(control, { ...opts.providers, now })
    : null;
  const links = providers
    ? createIdentityLinks(control, sessions, providers, (userId) => passkeys.methodCount(userId))
    : null;
  return {
    setup: createSetup(control, passwords, sessions, now, () => passkeys.available()),
    sessions,
    credentials: createCredentials(control, passwords, sessions, now),
    accounts: createAccounts(control, passwords, sessions, now),
    passkeys,
    providers,
    links,
    close() { passwords.close(); }, // DB lifetime belongs to the host.
  };
}
export type IdentityService = ReturnType<typeof createIdentityService>;
