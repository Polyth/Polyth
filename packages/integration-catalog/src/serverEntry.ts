// The catalog's HTTP surface: the validated list, the connected state, and the
// two mutations that install or remove one entry through the host's MCP service.
//
// Nothing here is tenant data except the installations, which are read and
// written through `mcp.project` with the request's own Space context — the
// package never touches a config file, and never sees a secret it did not just
// write.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RouteHandler, SpaceContext } from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { brandMarkFor } from "./brand.ts";
import { catalogStats } from "./catalog.ts";
import { loadCatalog, readAgentSkill, type CatalogLoad } from "./entries.ts";
import {
  installedFrom,
  planInstall,
  serverNameFor,
  type InstallHost,
  type InstallScope,
  type InstalledIntegration,
  type LiveInstallation,
  type McpInstallInput,
} from "./install.ts";
import { createInstallLedger, type InstallRecord } from "./installLedger.ts";
import type { IntegrationManifest } from "./manifest.ts";

export const INTEGRATION_CATALOG_PACKAGE_ID = "integration-catalog";

/** `GET /api/integration-catalog/entries` and `…/entries/<id>`. */
export const ENTRIES_PATH = "/api/integration-catalog/entries";
/** `POST /api/integration-catalog/install` and `…/uninstall`. */
export const INSTALL_PATH = "/api/integration-catalog/install";
export const UNINSTALL_PATH = "/api/integration-catalog/uninstall";
/** `GET /api/integration-catalog/logo/<id>`: a vendored brand glyph. */
export const LOGO_PATH = "/api/integration-catalog/logo";

/** `packages/integration-catalog/assets/logos`. */
const LOGO_DIR = fileURLToPath(new URL("../assets/logos/", import.meta.url));

const LOGO_TYPE: Record<"svg" | "png", string> = {
  svg: "image/svg+xml",
  png: "image/png",
};

/** The host service this package needs, as the methods it actually calls. */
export interface CatalogMcpService {
  list(space: SpaceContext, projectId?: string): LiveInstallation[];
  listPersonal(space: SpaceContext): LiveInstallation[];
  create(space: SpaceContext, input: McpInstallInput, projectId?: string): Promise<LiveInstallation>;
  createPersonal(space: SpaceContext, input: McpInstallInput): Promise<LiveInstallation>;
  remove(space: SpaceContext, id: string, projectId?: string): Promise<boolean>;
  removePersonal(space: SpaceContext, id: string): Promise<boolean>;
}

const MCP_SERVICE = serverServiceKey<CatalogMcpService>("mcp.project");

/** The skill library, as the two methods Connect and Disconnect call. Optional:
 *  without it a server still connects, only without its skill. */
export interface CatalogSkillService {
  save(
    space: SpaceContext,
    scope: "project" | "space",
    input: { name: string; description: string; instructions: string; expectedRevision?: number },
    projectId?: string,
  ): Promise<{ revision?: number }>;
  remove(space: SpaceContext, scope: "project" | "space", name: string, projectId?: string, expectedRevision?: number): Promise<boolean>;
}

const SKILL_SERVICE = serverServiceKey<CatalogSkillService>("skills");

export interface CatalogServerOptions {
  /** What this machine offers a local server; tests replace it. */
  installHost?: (snaps: readonly string[]) => InstallHost;
}

const defaultInstallHost = (snaps: readonly string[]): InstallHost => ({
  home: homedir(),
  snaps: process.platform === "linux" ? snaps.filter((name) => existsSync(`/snap/bin/${name}`)) : [],
});

const errorCode = (cause: unknown): string => {
  const code = (cause as { code?: unknown })?.code;
  return typeof code === "string" ? code : "unavailable";
};

const failureStatus = (code: string): number => {
  if (code === "invalid-input") return 400;
  if (code === "forbidden" || code === "unauthorized") return 403;
  if (code === "conflict") return 409;
  if (code === "not-found") return 404;
  if (code === "storage-unavailable") return 503;
  return 502;
};

export default function registerPackage(host: ServerPackageHost, options: CatalogServerOptions = {}): ServerPackage {
  const installHost = options.installHost ?? defaultInstallHost;
  /** Loaded once per process: the manifests ship with the build, so they
   *  change only on deploy or reload. */
  let loaded: Promise<CatalogLoad> | undefined;
  const catalog = (): Promise<CatalogLoad> => (loaded ??= loadCatalog());

  const mcp = (): CatalogMcpService => host.services.require(MCP_SERVICE);
  const ledger = (space: SpaceContext) =>
    createInstallLedger(host.spaceStorage(space).packageDir(host.pluginId));
  const skills = (): CatalogSkillService | undefined => host.services.get(SKILL_SERVICE);

  /** Adds an entry's agent skill beside its new server. Never fails the
   *  install: the server is connected either way, the note says what happened. */
  const installAgentSkill = async (
    space: SpaceContext,
    entry: IntegrationManifest,
    scope: InstallScope,
    projectId: string | undefined,
  ): Promise<{ skill?: NonNullable<InstallRecord["skill"]>; note: string }> => {
    const spec = entry.agentSkill!;
    if (scope === "person") {
      return { note: `The ${spec.name} skill was not added: skills reach a whole project or Space, and this connection is yours alone.` };
    }
    const library = skills();
    if (!library) return { note: `The ${spec.name} skill was not added: this Polyth has no skill library.` };
    const read = await readAgentSkill(entry);
    if (!read.ok) return { note: `The ${spec.name} skill was not added: ${read.problem}.` };
    try {
      const saved = await library.save(space, scope, {
        name: spec.name,
        description: spec.description,
        instructions: read.instructions,
        expectedRevision: 0,
      }, scope === "project" ? projectId : undefined);
      return {
        skill: { name: spec.name, revision: saved.revision ?? 1 },
        note: `Agents also get the ${spec.name} skill, which tells them when to use ${entry.name}.`,
      };
    } catch (cause) {
      if (errorCode(cause) === "conflict") {
        return { note: `A skill named ${spec.name} already exists here, so it was kept as it is.` };
      }
      return { note: `The ${spec.name} skill was not added: ${cause instanceof Error ? cause.message : "the skill library refused it"}.` };
    }
  };

  /** Removes the skill an install created, unless someone has changed it since. */
  const removeAgentSkill = async (space: SpaceContext, record: InstallRecord): Promise<string | undefined> => {
    const skill = record.skill;
    const library = skills();
    if (!skill || !library || record.scope === "person") return undefined;
    try {
      await library.remove(space, record.scope, skill.name, record.scope === "project" ? record.projectId : undefined, skill.revision);
      return undefined;
    } catch (cause) {
      return errorCode(cause) === "conflict"
        ? `The ${skill.name} skill was edited after it was added, so it was kept.`
        : `The ${skill.name} skill could not be removed: ${cause instanceof Error ? cause.message : "the skill library refused"}.`;
    }
  };

  /** Live servers that match a catalog entry, plus what the ledger owns, or
   *  null when the host cannot say: "nothing connected" and "cannot read the
   *  connections" are different answers and the page shows them differently. */
  const readInstalled = (
    space: SpaceContext,
    entries: CatalogLoad["entries"],
    projectId?: string,
  ): InstalledIntegration[] | null => {
    let spaceServers: LiveInstallation[] = [];
    let personalServers: LiveInstallation[] = [];
    try {
      const service = mcp();
      spaceServers = service.list(space, projectId);
      personalServers = service.listPersonal(space);
    } catch {
      return null;
    }
    return installedFrom(entries, spaceServers, personalServers, ledger(space).list());
  };
  const installedFor = (
    space: SpaceContext,
    entries: CatalogLoad["entries"],
    projectId?: string,
  ): InstalledIntegration[] => readInstalled(space, entries, projectId) ?? [];

  /** Brand marks are static deployment data: no Space, no tenant, no secret. */
  const serveLogo = (rc: Parameters<RouteHandler>[0], id: string): void => {
    const mark = brandMarkFor(id);
    if (!mark) {
      rc.json(404, { error: "not-found", message: "No brand mark for that entry." });
      return;
    }
    let body: Buffer;
    try {
      body = readFileSync(join(LOGO_DIR, mark.file));
    } catch {
      rc.json(404, { error: "not-found", message: "The brand mark is missing from this build." });
      return;
    }
    // Defence in depth: these files never carry script, but an SVG is markup
    // and the file could have been replaced on disk.
    if (mark.format === "svg" && /<script|<foreignObject|\son[a-z]+\s*=|<iframe|<image|href\s*=\s*["']?(?:https?:|data:|javascript:)/i.test(body.toString("utf8"))) {
      rc.json(415, { error: "unsupported-logo", message: "The brand mark is not a plain drawing." });
      return;
    }
    rc.res.writeHead(200, {
      "content-type": LOGO_TYPE[mark.format],
      "content-length": String(body.byteLength),
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    });
    rc.res.end(body);
  };

  const routes: RouteHandler = async (rc) => {
    const { path, method, json } = rc;

    if (path.startsWith(`${LOGO_PATH}/`)) {
      if (method !== "GET") {
        json(405, { error: "method-not-allowed", message: "Brand marks are read-only." });
        return true;
      }
      const id = path.slice(LOGO_PATH.length + 1);
      if (!id || id.includes("/") || id.includes(".")) {
        json(404, { error: "not-found", message: "No such brand mark." });
        return true;
      }
      serveLogo(rc, id);
      return true;
    }

    const isEntries = path === ENTRIES_PATH || path.startsWith(`${ENTRIES_PATH}/`);
    if (!isEntries && path !== INSTALL_PATH && path !== UNINSTALL_PATH) return false;

    const load = await catalog();

    if (isEntries) {
      if (method !== "GET") {
        json(405, { error: "method-not-allowed", message: "The integrations catalog is read-only." });
        return true;
      }
      if (path === ENTRIES_PATH) {
        const projectId = rc.url.searchParams.get("projectId")?.trim() || undefined;
        const installed = readInstalled(rc.space, load.entries, projectId);
        json(200, {
          entries: load.entries,
          problems: load.problems,
          stats: catalogStats(load.entries),
          installed: installed ?? [],
          connections: installed === null ? "unavailable" : "ok",
        });
        return true;
      }
      const id = path.slice(ENTRIES_PATH.length + 1);
      if (!id || id.includes("/")) {
        json(404, { error: "not-found", message: "No such catalog path." });
        return true;
      }
      const entry = load.entries.find((candidate) => candidate.id === id);
      if (!entry) {
        json(404, { error: "not-found", message: `No integration named "${id}".` });
        return true;
      }
      json(200, { entry });
      return true;
    }

    if (method !== "POST") {
      json(405, { error: "method-not-allowed", message: "Use POST for install and uninstall." });
      return true;
    }

    const body = await rc.body();
    const entryId = typeof body.entryId === "string" ? body.entryId : "";
    const entry = load.entries.find((candidate) => candidate.id === entryId);
    const projectId = typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : undefined;
    const store = ledger(rc.space);

    if (path === INSTALL_PATH) {
      const requestedScope = body.scope === "space" || body.scope === "project" || body.scope === "person"
        ? (body.scope as InstallScope)
        : undefined;
      const inputs = body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs)
        ? (body.inputs as Record<string, unknown>)
        : undefined;
      const snap = entry?.mcp.local?.snapData?.snap;
      const plan = planInstall(entry, {
        ...(typeof body.token === "string" ? { token: body.token } : {}),
        ...(requestedScope ? { scope: requestedScope } : {}),
        ...(inputs ? { inputs } : {}),
        ...(snap ? { host: installHost([snap]) } : {}),
      });
      if (!plan.ok) {
        json(plan.failure === "unknown-entry" ? 404 : 400, {
          error: plan.failure,
          message: plan.message,
        });
        return true;
      }
      // Without an open project a project install would land in the whole
      // Space; say so in the scope it is recorded and reported under.
      const scope: InstallScope = plan.scope === "project" && !projectId ? "space" : plan.scope;
      // A second click, or a second tab, must not create a duplicate server.
      const existing = installedFor(rc.space, load.entries, projectId).find((row) => row.entryId === entry!.id);
      if (existing) {
        json(409, {
          error: "already-installed",
          message: `${entry!.name} is already connected.`,
          installed: existing,
        });
        return true;
      }
      try {
        const created = scope === "person"
          ? await mcp().createPersonal(rc.space, plan.input)
          : await mcp().create(rc.space, plan.input, scope === "project" ? projectId : undefined);
        const notes = [...plan.notes];
        let skill: InstallRecord["skill"];
        if (entry!.agentSkill) {
          const added = await installAgentSkill(rc.space, entry!, scope, projectId);
          skill = added.skill;
          notes.push(added.note);
        }
        store.add({
          entryId: entry!.id,
          serverId: created.id,
          scope,
          ...(scope === "project" && projectId ? { projectId } : {}),
          ...(skill ? { skill } : {}),
          at: Date.now(),
        });
        json(200, {
          installed: installedFor(rc.space, load.entries, projectId).find((row) => row.serverId === created.id) ?? {
            entryId: entry!.id,
            serverId: created.id,
            name: serverNameFor(entry!),
            scope,
            revision: created.revision ?? 0,
            enabled: created.enabled !== false,
            catalogManaged: true,
          },
          notes,
        });
      } catch (cause) {
        const code = errorCode(cause);
        json(failureStatus(code), {
          error: code,
          message: cause instanceof Error ? cause.message : "The integration could not be installed.",
        });
      }
      return true;
    }

    // Uninstall removes only what this catalog installed.
    const records = store.forEntry(entryId);
    if (records.length === 0) {
      json(404, { error: "not-catalog-managed", message: `${entryId} was not installed from this catalog.` });
      return true;
    }
    let removed = 0;
    const notes: string[] = [];
    for (const record of records) {
      try {
        const gone = record.scope === "person"
          ? await mcp().removePersonal(rc.space, record.serverId)
          : await mcp().remove(rc.space, record.serverId, record.scope === "project" ? record.projectId : undefined);
        if (gone) removed += 1;
      } catch (cause) {
        const code = errorCode(cause);
        // A server already gone is not an error for uninstall.
        if (code !== "not-found") {
          json(failureStatus(code), {
            error: code,
            message: cause instanceof Error ? cause.message : "The integration could not be removed.",
          });
          return true;
        }
      }
      const note = await removeAgentSkill(rc.space, record);
      if (note) notes.push(note);
      store.forget(record.serverId);
    }
    json(200, { removed, installed: installedFor(rc.space, load.entries, projectId), notes });
    return true;
  };

  return {
    routes,
    remoteAccess: localOnlyRemoteAccess([INTEGRATION_CATALOG_PACKAGE_ID]),
  };
}
