export { canonicalHttpsIssuer, createProviderFramework } from './framework.ts';
export { githubDeviceFlowConfigured, githubIdentityAdapter } from './github/index.ts';
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
