import { localOnlyRemoteAccess, type ServerPackage } from "@polyth/plugins";

export default function registerPackage(): ServerPackage {
  return {
    remoteAccess: localOnlyRemoteAccess(["editor"]),
    routes: async () => false,
  };
}
