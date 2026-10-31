// Browser-safe public surface: capability names and DTO types only. The
// connector, OAuth flow and Google clients are server-only modules.
export {
  CAPABILITY_SPECS,
  GOOGLE_CAPABILITIES,
  grantedCapabilities,
  isGoogleCapability,
  type GoogleCapability,
  type GoogleService,
} from "./scopes.ts";
export type { GoogleAccountDto, GoogleAccountOwner, GoogleAccountStatus, GoogleClientConfigDto, GoogleServiceAccountLabelDto } from "./accounts.ts";
export type { OAuthFlowOwner, OAuthFlowStatus, OAuthFlowView } from "./oauth.ts";
