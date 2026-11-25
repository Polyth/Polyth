// `polyth_packages`: the agent's view of this installation's package manager,
// so the `polyth-packages` skill works on any install (Desktop, Docker, a
// server under any data dir) without guessing paths or versions. Read-only:
// it never installs, enables or grants anything. Installing stays the
// instance owner's action in Settings → Packages, where grants are reviewed.
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  UI_SLOTS,
  type AgentCapabilityContribution,
  type JsonObject,
  type SpaceStorage,
} from "@polyth/contracts";
import { assertEngineCompatible, requiredAssets } from "@polyth/package-sdk/manifest";
import { loadCanonicalManifest } from "./canonical.ts";
import { workstationEdition } from "./edition.ts";
import { ENGINE_VERSION, type PluginRegistry } from "./managedRegistry.ts";
import { buildSandboxBundle } from "./sandboxBundle.ts";
import { buildUiBundle } from "./uiBundle.ts";

export const PACKAGES_TOOL_NAME = "polyth_packages";

export interface PackageAuthoringRuntime {
  /** The trusted plugin directory `file:` sources resolve against. */
  trustedDir?: string;
  allowDevPath: boolean;
  registry(): PluginRegistry | null;
  /** The grant Space's storage; undefined when the Space is unknown. */
  spaceStorage(spaceId: string | undefined): SpaceStorage | undefined;
}

const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_LOG_LINES = 200;
const MAX_TEXT = 2_000;

const clip = (value: string): string => value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
const messageOf = (cause: unknown): string => clip(cause instanceof Error ? cause.message : String(cause));
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

const inputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["info", "list", "check", "logs"],
      description: "info: where to put a package on this installation and how to install it. list: installed packages and their state in this Space. check: validate and build the package folder <packageDir>/<id> exactly as install will, without installing. logs: an installed package's recent log lines.",
    },
    id: {
      type: "string",
      pattern: PACKAGE_ID.source,
      description: "Package id (check, logs).",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LOG_LINES,
      description: "logs: how many recent lines (default 50).",
    },
  },
};

function packageIdOf(input: JsonObject): string {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!PACKAGE_ID.test(id)) fail("invalid-input", "id must be a package id: lowercase letters, digits and dashes");
  return id;
}

function info(runtime: PackageAuthoringRuntime): JsonObject {
  const trustedDir = runtime.trustedDir ? resolve(runtime.trustedDir) : null;
  return {
    packageDir: trustedDir,
    packageDirExists: trustedDir ? existsSync(trustedDir) : false,
    installSource: trustedDir ? "file:<id>" : null,
    installLink: trustedDir ? "/?settings=packages&install=file:<id>" : null,
    installsAvailable: !workstationEdition(),
    devPathsAllowed: runtime.allowDevPath,
    engineVersion: ENGINE_VERSION,
    manifestFiles: {
      sandboxed: "polyth-package.json (manifestVersion 2, runtime.kind \"sandboxed\")",
      trustedServer: "polyth-package.json with runtime { kind: \"trusted-local\", server }, or polyth-plugin.json (entries.server, plus entries.ui and contributions for React UI in host slots)",
    },
    uiSlots: [...UI_SLOTS],
    limits: { files: 512, archiveMiB: 32, unpackedMiB: 64 },
    note: trustedDir
      ? "Write the package to <packageDir>/<id>/ (create packageDir if missing), run check, then give the person installLink with <id> filled in: Settings → Packages → Add package installs it after they review its access. packageDir is on the Polyth host; if your shell runs elsewhere (an SSH project), build the folder there and ask the person to upload it as a .zip in Add package instead."
      : "This installation has no trusted package directory: a package with server code cannot be installed. A sandboxed package can still be zipped and uploaded by the person in Settings → Packages → Add package.",
  };
}

function list(runtime: PackageAuthoringRuntime, registry: PluginRegistry, spaceId: string | undefined): JsonObject {
  const storage = runtime.spaceStorage(spaceId);
  return {
    packages: registry.list(storage).map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      source: plugin.source,
      status: plugin.status,
      enabled: plugin.enabled,
      ...(plugin.runtimeKind ? { runtimeKind: plugin.runtimeKind } : {}),
      ...(plugin.update ? { pendingVersion: plugin.update.version } : {}),
      ...(plugin.lastError ? { lastError: clip(plugin.lastError) } : {}),
    })),
  };
}

async function check(runtime: PackageAuthoringRuntime, id: string): Promise<JsonObject> {
  if (!runtime.trustedDir) fail("unavailable", "this installation has no trusted package directory");
  const base = resolve(runtime.trustedDir!);
  const dir = resolve(base, id);
  if (!dir.startsWith(base + sep)) fail("invalid-path", "package folder escapes the package directory");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { id, ok: false, problems: [`no package folder at ${dir}`] };
  }
  const problems: string[] = [];
  const warnings: string[] = [];
  let loaded: ReturnType<typeof loadCanonicalManifest>;
  try {
    loaded = loadCanonicalManifest(dir);
  } catch (cause) {
    return { id, ok: false, problems: [messageOf(cause)] };
  }
  const { canonical, legacy } = loaded;
  if (canonical.id !== id) problems.push(`manifest id "${canonical.id}" must equal the folder name "${id}"`);
  try {
    assertEngineCompatible(canonical, ENGINE_VERSION);
  } catch (cause) {
    problems.push(messageOf(cause));
  }
  for (const asset of requiredAssets(canonical)) {
    const path = join(dir, asset);
    if (!existsSync(path) || !statSync(path).isFile()) problems.push(`missing required asset ${asset}`);
  }
  const sandboxed = canonical.runtime?.kind === "sandboxed";
  if (sandboxed && canonical.runtime?.server) problems.push("sandboxed packages cannot execute server code");
  const scratch = mkdtempSync(join(tmpdir(), "polyth-package-check-"));
  try {
    if (!sandboxed && legacy.entries?.ui) {
      await buildUiBundle({ installDir: dir, entryPath: legacy.entries.ui, outDir: join(scratch, "ui") })
        .catch((cause: unknown) => { problems.push(`ui build: ${messageOf(cause)}`); });
    }
    if (sandboxed && canonical.runtime?.ui) {
      await buildSandboxBundle({ installDir: dir, entryPath: canonical.runtime.ui.entry, outDir: join(scratch, "sandbox") })
        .catch((cause: unknown) => { problems.push(`sandbox build: ${messageOf(cause)}`); });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (legacy.entries?.server) warnings.push("the server entry is not executed by check; its errors appear in logs after install");
  const installed = runtime.registry()?.has(id) ?? false;
  return {
    id,
    ok: problems.length === 0,
    version: canonical.version,
    runtimeKind: canonical.runtime?.kind ?? "trusted-local",
    installed,
    problems,
    warnings,
    next: problems.length
      ? "Fix the problems and run check again."
      : installed
        ? "Already installed: bump the manifest version, then the person presses Update on the package in Settings → Packages."
        : `Give the person /?settings=packages&install=file:${id} to install it.`,
  };
}

export function createPackagesAgentTool(owner: string, runtime: PackageAuthoringRuntime): AgentCapabilityContribution {
  return {
    descriptor: {
      id: `${owner}.packages`,
      kind: "tool",
      owner,
      scope: "deployment",
      revision: "1",
      name: PACKAGES_TOOL_NAME,
      description: "Inspect this Polyth installation's package manager for building the person's own packages: where package folders go and how they install (info), installed packages (list), a dry-run validation and build of a package folder (check), and an installed package's logs (logs). Read-only; installing and granting access stay the person's actions in Settings → Packages.",
      inputSchema,
      trust: "workspace",
      mutating: false,
    },
    async execute(input, context) {
      const action = input.action;
      if (action === "info") return { output: JSON.stringify(info(runtime)) };
      if (action === "check") return { output: JSON.stringify(await check(runtime, packageIdOf(input))) };
      const registry = runtime.registry() ?? fail("unavailable", "the package manager is not running");
      if (action === "list") return { output: JSON.stringify(list(runtime, registry, context.spaceId)) };
      if (action === "logs") {
        const id = packageIdOf(input);
        if (!registry.has(id)) fail("not-found", `package ${id} is not installed`);
        const limit = typeof input.limit === "number" ? Math.min(Math.max(1, Math.trunc(input.limit)), MAX_LOG_LINES) : 50;
        const lines = registry.logs(id, { limit: 10_000 }).slice(-limit).map((entry) => ({ at: entry.at, line: clip(entry.line) }));
        return { output: JSON.stringify({ id, lines }) };
      }
      return fail("invalid-input", "action must be info, list, check or logs");
    },
  };
}
