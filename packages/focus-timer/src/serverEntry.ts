// The focus timer lives in the browser: its running state stays on the device
// and its settings travel as an account UI preference. The server entry only
// makes the package discoverable, so Settings → Packages can turn it on or
// off. No routes, so nothing for paired devices to reach.
import { localOnlyRemoteAccess, type ServerPackage, type ServerPackageHost } from "@polyth/plugins";
import { FOCUS_TIMER_PACKAGE_ID } from "./index.ts";

export default function registerPackage(_host: ServerPackageHost): ServerPackage {
  return { remoteAccess: localOnlyRemoteAccess([FOCUS_TIMER_PACKAGE_ID]) };
}
