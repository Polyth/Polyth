import { localOnlyRemoteAccess, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";

// The indicator is entirely local: the price clock is computed in the browser
// from the provider's published UTC windows, so this package has no route, no
// storage and no network access. It still declares its (empty) remote policy
// so paired devices stay default-deny like every other package.
export default function registerPackage(_host: ServerPackageHost): ServerPackage {
  return { remoteAccess: localOnlyRemoteAccess(["peak-pricing"]) };
}
