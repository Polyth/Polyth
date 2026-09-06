// Protocol infrastructure registers no vendor profiles by itself. A harness
// package calls registerAcpProfile with its verified command and native probe.
import { localOnlyRemoteAccess } from "@polyth/plugins";
export default function registerPackage() { return { remoteAccess: localOnlyRemoteAccess(["backend-acp"]) }; }
