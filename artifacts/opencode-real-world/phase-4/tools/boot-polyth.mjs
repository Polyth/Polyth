// Phase-4 harness boot wrapper: runs the REAL Polyth composition root
// (packages/server/src/index.ts boot()) exactly like `npm start`, except the
// OpenCode protocol is forced (default legacy, like phases 1-3) and the
// harness can point the owned child at a shim binary / isolated config dir.
import { boot } from "/workspace/packages/server/src/index.ts";

const num = (name) => {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? undefined : Number(raw);
};

const opts = {
  port: num("PORT"),
  hostname: "127.0.0.1",
  dataDir: process.env.POLYTH_DATA_DIR,
  opencode: {
    protocol: process.env.OC_PROTOCOL ?? "legacy",
    ...(process.env.OC_BIN ? { bin: process.env.OC_BIN } : {}),
    ...(process.env.OC_CONFIG_DIR ? { dataDir: process.env.OC_CONFIG_DIR } : {}),
    ...(num("OC_STARTUP_DEADLINE_MS") !== undefined
      ? { startupDeadlineMs: num("OC_STARTUP_DEADLINE_MS") }
      : {}),
    ...(num("OC_PROBE_DEADLINE_MS") !== undefined
      ? { probeDeadlineMs: num("OC_PROBE_DEADLINE_MS") }
      : {}),
  },
};

boot(opts).then(() => {
  console.log("[harness] polyth boot complete");
}).catch((error) => {
  console.error("[harness] polyth boot failed", error);
  process.exitCode = 1;
});
