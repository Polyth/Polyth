import { localOnlyRemoteAccess, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";

// Everything is local: the policy snapshot ships in the package and is read
// in the browser, so this package has no route, no storage and no network
// access. It still declares its (empty) remote policy so paired devices stay
// default-deny like every other package.
export default function registerPackage(_host: ServerPackageHost): ServerPackage {
  return { remoteAccess: localOnlyRemoteAccess(["model-privacy"]) };
}
