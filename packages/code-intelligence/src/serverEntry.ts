import { localOnlyRemoteAccess, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";

// Web-only package: the language service is served by the editor package's own
// scoped route (`POST /api/editor/language`), so this entry owns no routes and
// no server state. It exists so the package is discovered and can be
// enabled/disabled like any other optional package.
export default function registerPackage(_host: ServerPackageHost): ServerPackage {
  return { remoteAccess: localOnlyRemoteAccess(["code-intelligence"]) };
}
