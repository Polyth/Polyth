#!/usr/bin/env node
// Source launcher for `polyth`. Node 22.18+ strips TypeScript natively; older
// supported Node (>= 22.16) needs the explicit flag, so re-exec once with it.
// Packaged builds (Polyth Desktop) ship a bundled JavaScript CLI instead.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));

if (process.features?.typescript || process.env.POLYTH_CLI_STRIPPED === "1") {
  const { main } = await import(entry);
  process.exitCode = await main(process.argv.slice(2));
} else {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, POLYTH_CLI_STRIPPED: "1" },
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
