import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessInstallDto } from "@polyth/contracts";
import { reinstallOffer, type HarnessUpdateRun } from "../widgets/updates.ts";

const failedRun: HarnessUpdateRun = { state: "failed", at: 1, output: "grok stopped with SIGILL", exitCode: null };
const job = (id: string, phase: HarnessInstallDto["phase"]): HarnessInstallDto => ({
  id, phase, startedAt: 2, output: "", harnessId: "grok", harnessName: "Grok Build", target: "local",
  machine: { kind: "local", os: "linux" }, command: "curl -fsSL https://x.ai/cli/install.sh | bash", sources: ["x.ai"], browserOnMachine: true,
} as HarnessInstallDto);
const base = { installCommand: "curl -fsSL https://x.ai/cli/install.sh | bash", mayUpdate: true, job: undefined, startedId: undefined };

test("a failed update offers the installer to someone who may update", () => {
  assert.deepEqual(reinstallOffer({ ...base, run: failedRun }), { kind: "offer", command: base.installCommand });
});

test("no offer without a failed run, an installer here, or update rights", () => {
  assert.equal(reinstallOffer({ ...base, run: undefined }).kind, "none");
  assert.equal(reinstallOffer({ ...base, run: { state: "running", startedAt: 1 } }).kind, "none");
  assert.equal(reinstallOffer({ ...base, run: { state: "done", at: 1, output: "" } }).kind, "none");
  assert.equal(reinstallOffer({ ...base, run: failedRun, installCommand: undefined }).kind, "none");
  assert.equal(reinstallOffer({ ...base, run: failedRun, mayUpdate: false }).kind, "none");
});

test("only the install this page started reports progress and outcome", () => {
  // An install from earlier (the first setup) is not this reinstall's result.
  assert.equal(reinstallOffer({ ...base, run: failedRun, job: job("old", "succeeded"), startedId: undefined }).kind, "offer");
  assert.equal(reinstallOffer({ ...base, run: failedRun, job: job("old", "succeeded"), startedId: "new" }).kind, "offer");
  assert.equal(reinstallOffer({ ...base, run: failedRun, job: job("new", "running"), startedId: "new" }).kind, "running");
  assert.equal(reinstallOffer({ ...base, run: failedRun, job: job("new", "queued"), startedId: "new" }).kind, "running");
  // The failed run is dismissed after success; the outcome still shows.
  assert.equal(reinstallOffer({ ...base, run: undefined, job: job("new", "succeeded"), startedId: "new" }).kind, "done");
  assert.equal(reinstallOffer({ ...base, run: failedRun, job: job("new", "failed"), startedId: "new" }).kind, "failed");
  // Stopped by the person: back to the plain offer.
  assert.equal(reinstallOffer({ ...base, run: failedRun, job: job("new", "cancelled"), startedId: "new" }).kind, "offer");
});

test("a refusal because Windows chats still run the CLI offers no reinstall", () => {
  // The installer would hit the same running file the updater could not replace.
  assert.equal(reinstallOffer({ ...base, run: { ...failedRun, output: "", busy: true } }).kind, "none");
});
