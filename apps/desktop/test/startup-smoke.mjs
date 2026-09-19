import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const executable = process.argv[2] ? resolve(process.argv[2]) : "";
if (!executable || !existsSync(executable)) {
  console.error(`startup-smoke: packaged executable is missing: ${executable || "<not provided>"}`);
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "polyth-desktop-smoke-"));
const outputLimit = 128 * 1024;
let stdout = "";
let stderr = "";
let settled = false;

const append = (current, chunk) => {
  if (current.length >= outputLimit) return current;
  return current + String(chunk).slice(0, outputLimit - current.length);
};

const child = spawn(executable, [], {
  env: {
    ...process.env,
    POLYTH_DESKTOP_STARTUP_SMOKE: "1",
    POLYTH_DESKTOP_USER_DATA: join(root, "user-data"),
    POLYTH_DATA_DIR: join(root, "data"),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });

const cleanup = () => {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
};

const fail = (message) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try { child.kill("SIGKILL"); } catch {}
  console.error(message);
  if (stdout) console.error(`--- stdout ---\n${stdout}`);
  if (stderr) console.error(`--- stderr ---\n${stderr}`);
  cleanup();
  process.exitCode = 1;
};

const timer = setTimeout(() => {
  fail("startup-smoke: packaged Polyth did not finish startup within 45 seconds");
}, 45_000);
timer.unref?.();

child.once("error", (error) => {
  fail(`startup-smoke: failed to launch packaged Polyth: ${error.message}`);
});

child.once("exit", (code, signal) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  const marker = "Desktop startup smoke passed";
  if (code !== 0 || !stdout.includes(marker)) {
    console.error(`startup-smoke: packaged Polyth exited with code ${code ?? "null"} signal ${signal ?? "none"} without a successful startup marker`);
    if (stdout) console.error(`--- stdout ---\n${stdout}`);
    if (stderr) console.error(`--- stderr ---\n${stderr}`);
    cleanup();
    process.exitCode = 1;
    return;
  }
  console.log("startup-smoke: packaged Polyth started its bundled server and exited cleanly");
  cleanup();
});
