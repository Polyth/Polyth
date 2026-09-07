import { connectPolyth as connectPolythHost, type PolythHost } from "./client.ts";

export {
  PackageHostError,
  PACKAGE_ERROR_CODES,
  isPackageErrorCode,
  resolvePackageErrorCode,
  type PackageErrorCode,
} from "./errors.ts";
export {
  PACKAGE_CAPABILITY_NAMES,
  isPackageCapabilityName,
  type DeclaredCapability,
  type PackageCapabilityName,
} from "./capabilities.ts";
export {
  type RemoteUiAction,
  type RemoteUiNode,
  type RemoteUiType,
} from "./remoteUi.ts";

export type { PolythHost };

/** Package-author entry. Host/test injection lives on `@polyth/package-sdk/host`. */
export function connectPolyth(): Promise<PolythHost> {
  return connectPolythHost();
}
