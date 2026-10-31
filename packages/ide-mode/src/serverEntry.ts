import { localOnlyRemoteAccess, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";

// Web-only package: the server entry exists so the package is discovered and
// can be enabled/disabled. It owns no routes or state.
export default function registerPackage(_host: ServerPackageHost): ServerPackage {
  return { remoteAccess: localOnlyRemoteAccess(["ide-mode"]) };
}
