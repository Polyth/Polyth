// Domain services only. The host must wire the authenticated gateway, secure
// ingress, UI and reviewed legacy migration before enabling account-first mode.
import { controlError, type ControlPlane } from '@polyth/control-plane';
import { createPasswordService, type PasswordService } from './passwords.ts';
import { createSessions, type IssuedSession } from './sessions.ts';
import { createSetup } from './setup.ts';
import { createCredentials } from './credentials.ts';
import { createAccounts } from './accounts.ts';
import { createGuardrails, type GuardrailsNormalizer } from './guardrails.ts';
import { createLimits, type LimitsNormalizer } from './limits.ts';
import { createPermissions, type PermissionsNormalizer } from './permissions.ts';
import { createPasskeys, type WebAuthnConfig } from './passkeys.ts';
import { createIdentityLinks } from './links.ts';
import { createAccessTokens, type AccessTokenPolicy } from './accessTokens.ts';
import { accessMode, requireOwnerCredential, type AccessMode } from './access.ts';
import { createOwnerCredential } from './ownerCredential.ts';
import {
  createProviderFramework,
  type IdentityProviderAdapter,
  type ProviderNetworkBroker,
  type ProviderSecretBroker,
} from './providers/index.ts';

export type { IdentityUser, IdentitySession, SessionSummary, SetupStatus } from './types.ts';
export type { GuardrailsNormalizer, GuardrailsService, StoredGuardrails } from './guardrails.ts';
export type { LimitsNormalizer, LimitsService, StoredLimits, UsageMetric, UsageToday } from './limits.ts';
export type { PermissionsNormalizer, PermissionsService, StoredPermissions } from './permissions.ts';
export type { CompleteSetup, CompleteLocalSetup } from './setup.ts';
export type { AccessMode } from './access.ts';
export { OWNER_LOGIN } from './ownerCredential.ts';
export type { OwnerCredentialService } from './ownerCredential.ts';
export type { IssuedSession } from './sessions.ts';
export type { PasswordService } from './passwords.ts';
export type { WebAuthnConfig, PasskeySummary } from './passkeys.ts';
export { ACCESS_TOKEN_PREFIX, CLI_TRUST_MODES, normalizeUserCode, validAccessToken } from './accessTokens.ts';
export type {
  AccessTokenKind,
  AccessTokenPolicy,
  AccessTokenService,
  AccessTokenSummary,
  CliTrust,
  CliTrustMode,
  DeviceAuthorizationDetails,
  DeviceAuthorizationStart,
  DeviceRedeemResult,
  IssuedAccessToken,
  ResolvedAccessToken,
} from './accessTokens.ts';
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
  ProviderNetworkRequest,
  ProviderNetworkResponse,
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
  /** Account guardrails validator from the host's contracts. Without it the
   *  feature is unavailable: writes fail and stored rows read fail-closed. */
  normalizeGuardrails?: GuardrailsNormalizer;
  /** Account limits validator from the host's contracts; same contract. */
  normalizeLimits?: LimitsNormalizer;
  /** Account permission vocabulary from the host's contracts. Without it no
   *  account holds a permission and writes fail. */
  normalizePermissions?: PermissionsNormalizer;
  /** Command-line access capability vocabulary from the host's contracts.
   *  Without it CLI tokens are unavailable and resolve to nothing. */
  accessTokens?: AccessTokenPolicy;
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
  const providerLogin = providers ? {
    begin(input: { providerId: string; browserBinding: string; callbackUrl: string; returnTo: string }) {
      return providers.begin({ ...input, purpose: 'login' });
    },
    async complete(input: { providerId: string; state: string; browserBinding: string; code: string; label?: string }) {
      // The external authorization code is single-use. Consume and clean up the
      // provider transaction first; an unlinked identity must not strand it in
      // the uncertain-exchange state merely because no Polyth account matches.
      const completed = await providers.complete({ ...input, purpose: 'login' });
      const userId = providers.resolveLinkedUser(input.providerId, completed.identity);
      if (!userId) throw controlError('invalid-credentials', 'External identity is not linked to an active account');
      const issued = control.transaction(() => sessions.issue(userId, input.label));
      return { ...completed, ...issued };
    },
  } : null;
  const accounts = createAccounts(control, passwords, sessions, now);
  const guardrails = createGuardrails(control, sessions, now, opts.normalizeGuardrails ?? (() => {
    throw controlError('unavailable', 'Account guardrails are unavailable');
  }));
  const limits = createLimits(control, sessions, now, opts.normalizeLimits ?? (() => {
    throw controlError('unavailable', 'Account limits are unavailable');
  }));
  const permissions = createPermissions(control, sessions, now, opts.normalizePermissions ?? (() => {
    throw controlError('unavailable', 'Account permissions are unavailable');
  }));
  /** The active owner of a ready `local` installation who truly holds no
   *  credential; the access mode alone is never trusted for that. */
  const credentialLessOwner = (): string | null => {
    if (control.installation().state !== 'ready' || accessMode(control) !== 'local') return null;
    const userId = accounts.activeOwnerUserId();
    if (!userId) return null;
    const credential = control.get(
      `SELECT 1 FROM password_credentials WHERE user_id=?1
       UNION ALL SELECT 1 FROM passkey_credentials WHERE user_id=?1
       UNION ALL SELECT 1 FROM login_identities WHERE user_id=?1 LIMIT 1`, userId,
    );
    return credential ? null : userId;
  };
  return {
    setup: createSetup(control, passwords, sessions, now, () => passkeys.available()),
    sessions,
    credentials: createCredentials(control, passwords, sessions, now),
    accounts,
    guardrails,
    limits,
    permissions,
    accessTokens: createAccessTokens(control, sessions, now, opts.accessTokens ?? null),
    /**
     * Local-only loopback trust (agent beta / local debug agent access): one
     * reusable owner session so the machine's own browser UI is never locked.
     * The host calls this only for direct-loopback requests in an explicitly
     * enabled local-only deployment; an unready installation or missing active
     * owner yields null instead of a credential.
     */
    issueLoopbackOwnerSession(label: string): IssuedSession | null {
      const userId = accounts.activeOwnerUserId();
      if (!userId) return null;
      return control.transaction(() => sessions.issue(userId, label));
    },
    /** `local` until the owner protects the account; see `access.ts`. */
    accessMode: (): AccessMode => accessMode(control),
    /** Throws `owner-credential-required` while the owner has no credential. */
    requireOwnerCredential: (): void => requireOwnerCredential(control),
    /**
     * The one way into a `local` installation: the Polyth Desktop main process
     * asks in-process (never over HTTP) and puts the session in its own
     * window's cookie jar. It replaces the previous session under the same
     * label, so launches never pile up sessions. Null once the owner has a
     * credential, before setup, or without an active owner.
     */
    issueLocalOwnerSession(label: string): IssuedSession | null {
      return control.transaction(() => {
        const userId = credentialLessOwner();
        if (!userId) return null;
        const replaced = control.run('DELETE FROM auth_sessions WHERE user_id=? AND label=?', userId, label);
        if (Number(replaced.changes) > 0) control.bumpEpoch();
        const issued = sessions.issue(userId, label);
        // A launch proves nothing fresh: only `confirmLocalOwnerSession`
        // (the Desktop main process again) elevates this session.
        control.run('UPDATE auth_sessions SET elevated_at_ms=NULL WHERE id=?', issued.session.id);
        return { token: issued.token, session: { ...issued.session, elevatedAt: null } };
      });
    },
    /**
     * The Desktop main process vouches, in-process, that the person at this
     * computer is acting now: it elevates its own window session (read from
     * its cookie jar) for the one step that needs it, protecting the account.
     * Never over HTTP, so a copied cookie can never elevate itself.
     */
    confirmLocalOwnerSession(label: string, token: string): boolean {
      return control.transaction(() => {
        const userId = credentialLessOwner();
        const session = userId ? sessions.resolve(token) : null;
        if (!session || session.userId !== userId) return false;
        const confirmed = control.run('UPDATE auth_sessions SET elevated_at_ms=?,revision=revision+1 WHERE id=? AND label=?', now(), session.id, label);
        return Number(confirmed.changes) === 1;
      });
    },
    ownerCredential: createOwnerCredential(control, passwords, sessions, now),
    passkeys,
    providers,
    providerLogin,
    links,
    close() { passwords.close(); }, // DB lifetime belongs to the host.
  };
}
export type IdentityService = ReturnType<typeof createIdentityService>;
