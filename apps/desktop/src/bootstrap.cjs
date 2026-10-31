const { appendFileSync, mkdirSync } = require("node:fs");
const { dirname } = require("node:path");
const { app } = require("electron");

const tracePath = process.env.POLYTH_DESKTOP_BOOTSTRAP_TRACE;
const trace = (message) => {
  if (!tracePath) return;
  try {
    mkdirSync(dirname(tracePath), { recursive: true });
    appendFileSync(tracePath, `${new Date().toISOString()} ${message}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {}
};

trace("CJS bootstrap entered");
void import("./main.js")
  .then(() => trace("ESM main module loaded"))
  .catch((error) => {
    const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    trace(`ESM main module failed: ${message}`);
    console.error("Polyth desktop main module failed", error);
    app.exit(1);
  });
