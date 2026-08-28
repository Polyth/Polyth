import { spawn } from "node:child_process";
import { join } from "node:path";
import { createOwnedLocalEndpointLease, createOpenCodeRuntimeLifecycle } from "@polyth/backend-opencode";
import { makeScratch, applyScratchEnv } from "./lib.ts";

const scratch = await makeScratch("debug-lease");
applyScratchEnv(scratch);
const lease = await createOwnedLocalEndpointLease({
  cwd: scratch.project,
  pidFile: join(scratch.root, "pid.json"),
  spawn: ((cmd: string, args: string[], opts: object) => {
    console.log("SPAWN:", cmd, JSON.stringify(args));
    const child = spawn(cmd, args, opts as never);
    child.stdout?.on("data", (c: Buffer) => process.stdout.write(`[child] ${c}`));
    child.stderr?.on("data", (c: Buffer) => process.stdout.write(`[child-err] ${c}`));
    return child;
  }) as typeof spawn,
});
try {
  const lifecycle = await createOpenCodeRuntimeLifecycle({ lease, protocol: "legacy" });
  console.log("READY", (await lifecycle.endpoint()).url);
  await lifecycle.dispose();
} catch (error) {
  console.log("FAILED", String(error));
  await lease.dispose();
}
