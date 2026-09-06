import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerAcpProfile } from "@polyth/backend-acp";
import type { ServerPackageHost } from "@polyth/plugins";
const exec = promisify(execFile);
export default function registerPackage(host: ServerPackageHost) {
    return registerAcpProfile(host, {
        descriptor: { "id": "fx", "name": "fx", "integration": "ACP v1", "autoSelect": false, "priority": 40, "setupUrl": "https://fx.sh/docs/using-fx/acp", "signInCommand": "fx login" },
        command: "fx", args: ["acp"],
        async probe(context) {
            if (context.remote || process.platform !== "linux")
                return { harnessId: "fx", installed: false, authenticated: "unknown", healthy: false };
            try {
                const version = (await exec("fx", ["--version"], { timeout: 5000, maxBuffer: 4096 })).stdout.trim();
                // Installation alone is not proof of authentication. The profile is
                // offered for explicit selection but excluded from automatic routing
                // until a native auth/status contract is verified.
                return { harnessId: "fx", installed: true, authenticated: "unknown", healthy: true, version, message: "Native sign-in status is not available" };
            }
            catch {
                return { harnessId: "fx", installed: false, authenticated: "unknown", healthy: false };
            }
        },
    });
}
