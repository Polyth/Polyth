export const PACKAGE_ERROR_CODES = [
  "HOST_UNAVAILABLE",
  "HOST_TIMEOUT",
  "PROTOCOL_MISMATCH",
  "PACKAGE_DISABLED",
  "CAPABILITY_UNDECLARED",
  "CAPABILITY_DENIED",
  "SPACE_UNAVAILABLE",
  "INVALID_REQUEST",
  "NETWORK_ORIGIN_DENIED",
  "NETWORK_TIMEOUT",
  "CONNECTION_REQUIRED",
  "RESOURCE_NOT_FOUND",
  "HOST_REJECTED",
] as const;

export type PackageErrorCode = (typeof PACKAGE_ERROR_CODES)[number];

const codes = new Set<string>(PACKAGE_ERROR_CODES);

export function isPackageErrorCode(value: string): value is PackageErrorCode {
  return codes.has(value);
}

export function resolvePackageErrorCode(value: string | undefined): PackageErrorCode {
  return value && isPackageErrorCode(value) ? value : "HOST_REJECTED";
}

export class PackageHostError extends Error {
  readonly code: PackageErrorCode;

  constructor(code: PackageErrorCode, message: string) {
    super(message);
    this.name = "PackageHostError";
    this.code = code;
  }
}
