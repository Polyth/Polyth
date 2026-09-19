import { localOnlyRemoteAccess, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";

export default function registerPackage(_host: ServerPackageHost): ServerPackage {
  return {
    remoteAccess: localOnlyRemoteAccess(["playground"]),
  };
}
