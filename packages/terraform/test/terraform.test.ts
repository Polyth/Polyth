import test from "node:test";
import assert from "node:assert/strict";
import fsPromises, { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import type { ServerPackageHost } from "@polyth/plugins";
import type { ProjectToolScope } from "@polyth/terminal/tool-types";
import { summarizeTerraformPlan, terraformCommand, terraformPlan, terraformSnapshot } from "../src/service.ts";
import registerPackage, { terraformRoutes } from "../src/serverEntry.ts";

const scratch = resolve(import.meta.dirname, "../../../.scratch/docker-terraform");
const plan = {
  format_version: "1.2", terraform_version: "1.14.0", applyable: true,
  variables: { token: { value: "SECRET-MUST-STAY-PRIVATE" } },
  planned_values: { outputs: { key: { value: "SECRET-MUST-STAY-PRIVATE" } } },
  resource_changes: [
    { address: "aws_instance.create", type: "aws_instance", change: { actions: ["create"], after: { password: "SECRET-MUST-STAY-PRIVATE" } } },
    { address: "aws_instance.replace", type: "aws_instance", change: { actions: ["delete", "create"], before: { token: "SECRET-MUST-STAY-PRIVATE" } } },
    { address: "aws_instance.unchanged", change: { actions: ["no-op"] } },
    { address: "aws_instance.update", change: { actions: ["update"] } },
    { address: "aws_instance.remove", change: { actions: ["delete"] } },
    { address: "data.aws_ami.latest", change: { actions: ["read"] } },
  ],
};

test("plan summaries count replacement once and never expose values, outputs or state", () => {
  const summary = summarizeTerraformPlan(plan);
  assert.deepEqual(summary.counts, { create: 1, update: 1, delete: 1, replace: 1, read: 1, forget: 0, other: 0 });
  assert.equal(summary.changes.length, 5);
  assert.equal(JSON.stringify(summary).includes("SECRET"), false);
  assert.equal("planned_values" in summary, false);
  assert.equal("variables" in summary, false);
  assert.throws(() => summarizeTerraformPlan({ format_version: "1.0", values: { root_module: {} } }), { code: "invalid-input" }, "state JSON is not a plan");
  assert.throws(() => summarizeTerraformPlan({ ...plan, format_version: "2.0" }), { code: "invalid-input" });
});

test("configuration discovery and terminal previews stay inside the chosen root", async (t) => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "terraform-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "env/dev/.terraform"), { recursive: true });
  await writeFile(join(root, "env/dev/main.tf"), "");
  await writeFile(join(root, "env/dev/terraform.tfvars"), "token = secret");
  await writeFile(join(root, "env/dev/polyth.tfplan.json"), JSON.stringify(plan));
  const scope = { projectId: "p1", repositoryId: "r1", root, alias: "Infra", repositories: [] } as ProjectToolScope;
  let runs = 0;
  const run = async () => { runs++; return { stdout: '{"terraform_version":"1.14.0"}', exitCode: 0 }; };
  const snapshot = await terraformSnapshot(scope, run);
  assert.deepEqual(snapshot.roots, [{ directory: "env/dev", files: ["env/dev/main.tf"], initialized: true }]);
  assert.deepEqual(snapshot.plans, ["env/dev/polyth.tfplan.json"]);
  const summary = await terraformPlan(scope, snapshot.plans[0]!, run);
  assert.equal(JSON.stringify(summary).includes("SECRET"), false);
  assert.equal(runs, 1, "JSON review does not invoke the CLI");
  const preview = await terraformCommand(scope, { directory: "env/dev", action: "plan" });
  assert.ok(preview.cmd.includes(`'-chdir=${join(root, "env/dev")}'`));
  assert.ok(preview.cmd.includes("'-out=polyth.tfplan'"));
  assert.equal(runs, 1, "preview does not execute the plan");
  await assert.rejects(terraformCommand(scope, { directory: ".", action: "init" }), { code: "not-found" });
  await assert.rejects(terraformCommand(scope, { directory: "env/dev", action: "apply" as never }), { code: "invalid-input" });
  await symlink(join(root, "env/dev/polyth.tfplan.json"), join(root, "link.tfplan.json"));
  // A symlink to an in-scope file is safe; an outside target is refused.
  await assert.rejects(terraformPlan(scope, "../outside.tfplan.json", run), { code: "invalid-input" });
});

test("binary plans stay pinned through pathname replacement and return a sanitized summary", { skip: process.platform !== "linux" }, async (t) => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "terraform-binary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "polyth.tfplan"), "binary");
  const scope = { projectId: "p1", repositoryId: "r1", root, alias: "Infra", repositories: [] } as ProjectToolScope;
  let args: string[] = [];
  const summary = await terraformPlan(scope, "polyth.tfplan", async (command, input, _cwd, pinned) => {
    assert.equal(command, "terraform"); args = input;
    await rename(join(root, "polyth.tfplan"), join(root, "original.tfplan"));
    await writeFile(join(root, "polyth.tfplan"), "replacement binary");
    assert.equal(await fsPromises.readFile(input.at(-1)!, "utf8"), "binary", "a pathname replacement cannot redirect the CLI's verified descriptor");
    await pinned!.close();
    return { stdout: JSON.stringify(plan), exitCode: 0 };
  });
  assert.deepEqual(args.slice(0, 3), [`-chdir=${root}`, "show", "-json"]);
  assert.match(args[3]!, /^\/proc\/\d+\/fd\/\d+$/);
  assert.equal(summary.counts.replace, 1);
  assert.equal(JSON.stringify(summary).includes("SECRET"), false);
});

test("Terraform refuses foreign-Space IDs before CLI and plan reads; lifecycle remains local-only", async () => {
  let runs = 0;
  const host = { deployment: "local-trusted", forSpace: () => ({ projects: { get: async () => undefined } }), projects: { get: async () => ({ id: "foreign", path: "/foreign" }) } } as unknown as ServerPackageHost;
  const route = terraformRoutes(host, async () => { runs++; return { stdout: "", exitCode: 0 }; });
  for (const path of ["/api/terraform/workspace", "/api/terraform/plan"]) await assert.rejects(route({ path, method: "GET", url: new URL(`http://test${path}?projectId=foreign&file=plan.tfplan`), space: {}, json: () => {} } as never), { code: "not-found" });
  assert.equal(runs, 0);
  const pkg = registerPackage(host);
  assert.deepEqual(pkg.remoteAccess, { routeScopes: ["terraform"], http: [] });
  await pkg.onEnable!(); await pkg.onDisable!(); await pkg.onEnable!(); await pkg.onDisable!();
});


test("plan review rejects a parent directory swapped after path validation", async (t) => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "terraform-swap-"));
  const foreign = await mkdtemp(join(scratch, "foreign-project-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(foreign, { recursive: true, force: true }); });
  const directory = join(root, "infra");
  const parked = join(root, "original");
  const target = join(directory, "polyth.tfplan.json");
  await mkdir(directory);
  await writeFile(target, JSON.stringify(plan));
  await writeFile(join(foreign, "polyth.tfplan.json"), JSON.stringify({
    format_version: "1.0", resource_changes: [{ address: "foreign_resource", change: { actions: ["create"] } }],
  }));
  const scope = { projectId: "own", repositoryId: "r1", root, alias: "Infra", repositories: [] } as ProjectToolScope;
  const originalOpen = fsPromises.open;
  let swapped = false;
  fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] !== target) return originalOpen(...args);
    swapped = true;
    await rename(directory, parked);
    await symlink(foreign, directory, "dir");
    try { return await originalOpen(...args); }
    finally { await rm(directory); await rename(parked, directory); }
  }) as typeof originalOpen;
  syncBuiltinESMExports();
  try {
    await assert.rejects(terraformPlan(scope, "infra/polyth.tfplan.json", async () => { throw new Error("JSON review must not invoke CLI"); }), { code: "invalid-input" });
    assert.equal(swapped, true, "the fixture reaches the actual open boundary");
  } finally { fsPromises.open = originalOpen; syncBuiltinESMExports(); }
});
