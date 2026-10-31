import test from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

// This suite mounts the real Composer in Happy DOM. Isolate its large import
// graph and failure formatting even when someone invokes this file directly
// without `--test`. Concurrency alone does not constrain memory or duration.
test("workflow launcher UI (bounded process)", { timeout: 65_000 }, async (context) => {
  const workerEnv: NodeJS.ProcessEnv = { ...process.env, GOMAXPROCS: "1", GOMEMLIMIT: "128MiB" };
  // A parent `node --test` worker requests a binary IPC reporter through this
  // variable. This independent subprocess reports plain TAP through its pipe.
  delete workerEnv.NODE_TEST_CONTEXT;
  await new Promise<void>((resolve, reject) => {
    const worker = (execFile as any)(process.execPath, [
      "--max-old-space-size=384",
      "--experimental-strip-types",
      "--test-concurrency=1",
      fileURLToPath(new URL("./workflowLauncherUi.cases.ts", import.meta.url)),
    ], {
      timeout: 60_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      env: workerEnv,
      encoding: "utf8",
      detached: process.platform !== "win32",
    }, (error: any, stdout: string, stderr: string) => {
      // Text only: never retain or print DOM objects from the worker.
      for (const line of `${stdout}\n${stderr}`.split("\n")) {
        if (line) context.diagnostic(line);
      }
      if (error) {
        reject(new Error(`Workflow UI worker failed or exceeded its limits (${error.code ?? error.signal ?? "unknown"}). See diagnostics.`));
      } else {
        resolve();
      }
    });
    worker.once("exit", () => {
      // Release transform helpers as well as the worker on timeout/failure.
      // The group belongs only to the child created by this test.
      if (process.platform !== "win32" && worker.pid) {
        try { process.kill(-worker.pid, "SIGKILL"); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") reject(cause); }
      }
    });
  });
});
