#!/usr/bin/env node
import { resolve } from "node:path";
import { openControlPlane } from "../packages/control-plane/src/index.ts";
import { createIdentityService } from "../packages/identity/src/index.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--data");
const dataDir = at >= 0 && args[at + 1] && !args[at + 1]!.startsWith("--")
  ? resolve(args[at + 1]!)
  : resolve(process.env.POLYTH_DATA_DIR ?? "./data");

let control: ReturnType<typeof openControlPlane> | undefined;
let identity: ReturnType<typeof createIdentityService> | undefined;
try {
  control = openControlPlane({ directory: dataDir });
  identity = createIdentityService(control);
  const claim = identity.setup.issueClaim();
  process.stdout.write(`${JSON.stringify({
    claimToken: claim.token,
    expiresAt: claim.expiresAt,
    dataDir,
  }, null, 2)}\n`);
} catch (error) {
  const code = (error as { code?: unknown } | null)?.code;
  process.stderr.write(`${typeof code === "string" ? code : "setup-claim-failed"}\n`);
  process.exitCode = 1;
} finally {
  try { identity?.close(); } catch { /* preserve command result */ }
  try { control?.close(); } catch { /* preserve command result */ }
}
