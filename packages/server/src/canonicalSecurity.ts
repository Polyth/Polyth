import type { IdentityProviderAdapter, PasswordService, WebAuthnConfig } from "@polyth/identity";
import {
  bitbucketIdentityAdapter,
  createIdentityService,
  githubIdentityAdapter,
  type IdentityService,
} from "@polyth/identity";
import { createIdentityHttpAdapter } from "@polyth/identity/http";
import { openControlPlane, type ControlPlane } from "@polyth/control-plane";
import {
  createResourceAccessAuthority,
  type ResourceAccessAuthority,
} from "@polyth/control-plane/resource-access";
import {
  createResourceLifecycleAuthority,
  type ResourceLifecycleAuthority,
} from "@polyth/control-plane/resource-lifecycle";
import { createResourceRegistry, type ResourceRegistry } from "@polyth/control-plane/resources";
import { createCanonicalAuthGateway, type CanonicalAuthGateway } from "./canonicalAuth.ts";
import {
  createCanonicalProviderNetwork,
  createCanonicalProviderSecrets,
} from "./providerHost.ts";

export interface CanonicalSecurityOptions {
  dataDir: string;
  /** Canonical browser origin. Never derive this from Host/X-Forwarded-* input. */
  origin: string;
  /** Explicit local development/native exception for HTTP loopback. */
  localOnly?: boolean;
  /** Validated bootstrap-only local agent debug authority. */
  debugAgentAccess?: boolean;
  now?: () => number;
  idleMs?: number;
  absoluteMs?: number;
  passwords?: PasswordService;
  webauthn?: Omit<WebAuthnConfig, "origin">;
  /** Host-reviewed adapters only. GitHub + Bitbucket Cloud are enabled by default. */
  providerAdapters?: IdentityProviderAdapter[];
}

export interface CanonicalSecurity {
  control: ControlPlane;
  identity: IdentityService;
  auth: CanonicalAuthGateway;
  resources: ResourceRegistry;
  resourceLifecycle: ResourceLifecycleAuthority;
  resourceAccess: ResourceAccessAuthority;
  http: ReturnType<typeof createIdentityHttpAdapter>;
  /** Operator channel only. Do not expose this through public HTTP routes. */
  issueSetupClaim(): ReturnType<IdentityService["setup"]["issueClaim"]>;
  close(): void;
}

/**
 * Open the one canonical security authority before any feature store writes to
 * the data root. `openControlPlane()` deliberately refuses to initialize when
 * legacy/application data already exists without its installation sentinel;
 * callers must run the reviewed migration instead of bootstrapping a second
 * owner over legacy state.
 */
export function createCanonicalSecurity(options: CanonicalSecurityOptions): CanonicalSecurity {
  const control = openControlPlane({ directory: options.dataDir });
  let identity: IdentityService | undefined;
  try {
    const providerSecrets = createCanonicalProviderSecrets(options.dataDir);
    const providerNetwork = createCanonicalProviderNetwork(control);
    identity = createIdentityService(control, {
      ...(options.now ? { now: options.now } : {}),
      ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
      ...(options.absoluteMs !== undefined ? { absoluteMs: options.absoluteMs } : {}),
      ...(options.passwords ? { passwords: options.passwords } : {}),
      webauthn: { origin: options.origin, ...options.webauthn },
      providers: {
        adapters: options.providerAdapters ?? [githubIdentityAdapter, bitbucketIdentityAdapter],
        secrets: providerSecrets,
        network: providerNetwork,
      },
    });
    const resources = createResourceRegistry(control, options.now ? { now: options.now } : {});
    const resourceLifecycle = createResourceLifecycleAuthority(
      control,
      resources,
      options.now ? { now: options.now } : {},
    );
    const resourceAccess = createResourceAccessAuthority(
      control,
      resources,
      options.now ? { now: options.now } : {},
    );
    const http = createIdentityHttpAdapter(identity, {
      origin: options.origin,
      ...(options.localOnly !== undefined ? { localOnly: options.localOnly } : {}),
    });
    const auth = createCanonicalAuthGateway({
      control,
      identity,
      cookieName: http.cookieName,
      ...(options.debugAgentAccess ? { debugAgentAccess: true } : {}),
    });
    let closed = false;
    return {
      control,
      identity,
      auth,
      resources,
      resourceLifecycle,
      resourceAccess,
      http,
      issueSetupClaim: () => identity!.setup.issueClaim(),
      close() {
        if (closed) return;
        closed = true;
        identity!.close();
        control.close();
      },
    };
  } catch (cause) {
    try { identity?.close(); } finally { control.close(); }
    throw cause;
  }
}
