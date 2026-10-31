import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { checkedToolPath, discoverToolFiles, openProjectToolFile, projectToolCommand, readProjectToolFile, toolError, type ToolRun } from "@polyth/terminal/project-tools";
import type { ProjectToolScope, ToolAvailability, ToolCommandPreview } from "@polyth/terminal/tool-types";
import type { TerraformAction, TerraformChangeAction, TerraformPlanSummary, TerraformSnapshot } from "./types.ts";

export const isTerraformFile = (name: string): boolean => name.endsWith(".tf") || name.endsWith(".tf.json");
export const isTerraformPlan = (name: string): boolean => name === "tfplan" || name.endsWith(".tfplan") || name.endsWith(".tfplan.json") || name === "terraform-plan.json";

/** Strict allowlist: state, values, outputs, diagnostics and configuration never leave this function. */
export function summarizeTerraformPlan(input: unknown): TerraformPlanSummary {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw toolError("invalid-input", "This is not a Terraform plan JSON document.");
  const plan = input as Record<string, unknown>;
  if (typeof plan.format_version !== "string" || !plan.format_version.startsWith("1.")
    || (!Array.isArray(plan.resource_changes) && !plan.planned_values)) throw toolError("invalid-input", "Unsupported Terraform plan format. Export it with terraform show -json.");
  const summary: TerraformPlanSummary = { changes: [], counts: { create: 0, update: 0, delete: 0, replace: 0, read: 0, forget: 0, other: 0 } };
  if (typeof plan.terraform_version === "string") summary.terraformVersion = plan.terraform_version.slice(0, 80);
  if (typeof plan.applyable === "boolean") summary.applyable = plan.applyable;
  if (typeof plan.errored === "boolean") summary.errored = plan.errored;
  const rows = Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
  if (rows.length > 5000) throw toolError("invalid-input", "This plan is too large to review in the panel.");
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") throw toolError("invalid-input", "Invalid resource change in plan.");
    const row = raw as { address?: unknown; type?: unknown; change?: { actions?: unknown } };
    const actions = row.change?.actions;
    if (!Array.isArray(actions) || !actions.every((action) => typeof action === "string") || typeof row.address !== "string") throw toolError("invalid-input", "Invalid resource change in plan.");
    if (actions.length === 1 && actions[0] === "no-op") continue;
    let action: TerraformChangeAction = "other";
    if (actions.includes("create") && actions.includes("delete")) action = "replace";
    else if (actions.length === 1 && ["create", "update", "delete", "read", "forget"].includes(actions[0]!)) action = actions[0] as TerraformChangeAction;
    summary.counts[action]++;
    summary.changes.push({ address: row.address.slice(0, 2048), type: typeof row.type === "string" ? row.type.slice(0, 120) : "", action });
  }
  return summary;
}

export async function terraformSnapshot(scope: ProjectToolScope, run: ToolRun): Promise<TerraformSnapshot> {
  const found = await discoverToolFiles(scope.root, (name) => isTerraformFile(name) || isTerraformPlan(name));
  const grouped = new Map<string, string[]>();
  for (const file of found.files.filter((path) => isTerraformFile(path.split("/").at(-1)!))) {
    const directory = dirname(file).replaceAll("\\", "/");
    grouped.set(directory, [...(grouped.get(directory) ?? []), file]);
  }
  const roots = [];
  for (const [directory, files] of grouped) {
    let initialized = false;
    try { await checkedToolPath(scope.root, `${directory}/.terraform`, "directory"); initialized = true; } catch { /* init has not created a local working directory */ }
    roots.push({ directory, files, initialized });
  }
  let cli: ToolAvailability;
  try {
    const result = await run("terraform", ["version", "-json"], scope.root);
    const version = result.exitCode === 0 ? JSON.parse(result.stdout) as { terraform_version?: unknown } : undefined;
    cli = typeof version?.terraform_version === "string" ? { available: true, version: version.terraform_version.slice(0, 80) } : { available: false, message: "Terraform CLI is unavailable. Install it on the Polyth host." };
  } catch (cause) {
    cli = (cause as { reason?: string } | null)?.reason === "read-only-preview"
      ? { available: false, reason: "read-only-preview", message: "CLI inspection is disabled in this read-only preview." }
      : { available: false, message: "Terraform CLI could not run. Check the installation." };
  }
  return { scope, cli, roots, plans: found.files.filter((path) => isTerraformPlan(path.split("/").at(-1)!)), truncated: found.truncated };
}

export async function terraformPlan(scope: ProjectToolScope, file: string, run: ToolRun): Promise<TerraformPlanSummary> {
  if (!isTerraformPlan(file.split("/").at(-1) ?? "")) throw toolError("invalid-input", "Choose a saved Terraform plan.");
  const target = await checkedToolPath(scope.root, file);
  if ((await stat(target)).size > 4 * 1024 * 1024) throw toolError("invalid-input", "This plan is too large to review in the panel.");
  let output: string;
  if (file.endsWith(".json")) {
    output = (await readProjectToolFile(scope.root, file, 4 * 1024 * 1024)).toString("utf8");
  }
  else {
    if (process.platform !== "linux") throw toolError("unsupported", "Review exported JSON plans on this platform; binary plan inspection requires Linux file pinning.");
    const pinned = await openProjectToolFile(scope.root, file, 4 * 1024 * 1024);
    // The runner owns this descriptor until its exact CLI authority is released.
    // A later pathname swap cannot redirect Terraform to another project's file.
    const result = await run("terraform", [`-chdir=${dirname(target)}`, "show", "-json", `/proc/${process.pid}/fd/${pinned.handle.fd}`], scope.root, pinned);
    if (result.exitCode !== 0) throw toolError("unavailable", "The saved plan could not be read. Check Terraform in the terminal.");
    output = result.stdout;
  }
  let plan: unknown;
  try { plan = JSON.parse(output); } catch { throw toolError("invalid-input", "The saved plan is not valid Terraform JSON."); }
  return summarizeTerraformPlan(plan);
}

export async function terraformCommand(scope: ProjectToolScope, input: { directory: string; action: TerraformAction }): Promise<ToolCommandPreview> {
  if (!["init", "validate", "format-check", "plan"].includes(input.action)) throw toolError("invalid-input", "Unknown Terraform action.");
  const directory = await checkedToolPath(scope.root, input.directory, "directory");
  const found = await discoverToolFiles(scope.root, isTerraformFile);
  if (!found.files.some((file) => dirname(file).replaceAll("\\", "/") === input.directory)) throw toolError("not-found", "Terraform configuration not found in this directory.");
  const operations: Record<TerraformAction, { title: string; explanation: string; args: string[] }> = {
    init: { title: "Initialize configuration", explanation: "Initialize this backend and download its configured modules and providers.", args: ["init", "-input=false"] },
    validate: { title: "Validate configuration", explanation: "Check this configuration's syntax and internal consistency. Initialize it first if providers are missing.", args: ["validate", "-no-color"] },
    "format-check": { title: "Check formatting", explanation: "Check formatting in this directory without rewriting configuration files.", args: ["fmt", "-check", "-no-color"] },
    plan: { title: "Create plan", explanation: "Read the configured backend and provider APIs and save planned changes to polyth.tfplan. This replaces an earlier plan with that filename. Refresh the panel after completion to review it.", args: ["plan", "-input=false", "-no-color", "-out=polyth.tfplan"] },
  };
  const operation = operations[input.action];
  if (!operation) throw toolError("invalid-input", "Unknown Terraform action.");
  return projectToolCommand(scope, operation.title, operation.explanation, "terraform", [`-chdir=${directory}`, ...operation.args]);
}
