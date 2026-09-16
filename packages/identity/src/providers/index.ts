export { canonicalHttpsIssuer, createProviderFramework } from './framework.ts';
export { githubDeviceFlowConfigured, githubIdentityAdapter } from './github/index.ts';
export { createGitLabIdentityAdapter } from './gitlab/index.ts';
export type { GitLabOidcVerifier, GitLabOidcVerificationInput } from './gitlab/index.ts';
export type {
  IdentityProviderAdapter,
  NormalizedExternalIdentity,
  ProviderBeginInput,
  ProviderBeginResult,
  ProviderCapabilities,
  ProviderConfiguration,
  ProviderExchangeInput,
  ProviderNetworkBroker,
  ProviderNetworkRequest,
  ProviderNetworkResponse,
  ProviderPurpose,
  ProviderSecretBroker,
  ProviderTransactionStart,
} from './types.ts';
