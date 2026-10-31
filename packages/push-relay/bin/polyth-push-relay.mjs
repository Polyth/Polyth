#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const child = spawnSync(process.execPath, ["--experimental-strip-types", new URL("../src/cli.ts", import.meta.url).pathname, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exitCode = child.status ?? 1;
