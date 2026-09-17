export type ProviderPurpose = 'setup' | 'login' | 'link';

export interface ProviderCapabilities {
  web: boolean;
  device?: boolean;
  refresh?: boolean;
  revoke?: boolean;
  discovery?: boolean;
}

export interface NormalizedExternalIdentity {
  issuer: string;
  subject: string;
  displayName?: string;
  email?: string;
  emailVerified?: boolean;
}

export interface ProviderNetworkRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}
export interface ProviderNetworkResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The host owns SSRF/DNS/redirect policy. Adapters never receive fetch(). */
export interface ProviderNetworkBroker {
  request(providerId: string, expectedIssuer: string, request: ProviderNetworkRequest): Promise<ProviderNetworkResponse>;
}

/** Secrets are opaque references. Implementations may use keychain, vault, etc. */
export interface ProviderSecretBroker {
  put(purpose: string, secret: string): Promise<string>;
  get(reference: string): Promise<string>;
  delete(reference: string): Promise<void>;
}

export interface ProviderBeginInput {
  providerId: string;
  issuer: string;
  purpose: ProviderPurpose;
  publicConfig: Readonly<Record<string, unknown>>;
  callbackUrl: string;
  state: string;
  nonce: string;
  pkceChallenge: string;
}
export interface ProviderBeginResult { authorizationUrl: string }
export interface ProviderExchangeInput {
  providerId: string;
  issuer: string;
  purpose: ProviderPurpose;
  publicConfig: Readonly<Record<string, unknown>>;
  callbackUrl: string;
  code: string;
  state: string;
  nonce: string;
  pkceVerifier: string;
  clientSecret: string | null;
}

export interface IdentityProviderAdapter<ExchangeResult = unknown> {
  readonly kind: string;
  readonly capabilities: Readonly<ProviderCapabilities>;
  canonicalizeIssuer(value: string): string;
  begin(input: ProviderBeginInput): Promise<ProviderBeginResult> | ProviderBeginResult;
  exchange(input: ProviderExchangeInput, network: ProviderNetworkBroker): Promise<ExchangeResult>;
  resolveIdentity(result: ExchangeResult, network: ProviderNetworkBroker): Promise<NormalizedExternalIdentity>;
  refresh?(result: ExchangeResult, network: ProviderNetworkBroker): Promise<ExchangeResult>;
  revoke?(result: ExchangeResult, network: ProviderNetworkBroker): Promise<void>;
}

export interface ProviderConfiguration {
  id: string;
  kind: string;
  issuer: string;
  enabled: boolean;
  publicConfig: Readonly<Record<string, unknown>>;
  revision: number;
}

export interface ProviderTransactionStart {
  id: string;
  providerId: string;
  purpose: ProviderPurpose;
  state: string;
  authorizationUrl: string;
  expiresAt: number;
  returnTo: string;
}
