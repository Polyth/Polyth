// The catalog's HTTP surface: the validated list, the connected state, and the
// two mutations that install or remove one entry through the host's MCP service.
//
// Nothing here is tenant data except the installations, which are read and
// written through `mcp.project` with the request's own Space context — the
// package never touches a config file, and never sees a secret it did not just
// write.
import { readFileSync } from "node:fs";
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
import { loadCatalog, type CatalogLoad } from "./entries.ts";
import {
  installedFrom,
  planInstall,
  serverNameFor,
  type InstallScope,
  type InstalledIntegration,
  type LiveInstallation,
  type McpInstallInput,
} from "./install.ts";
import { createInstallLedger } from "./installLedger.ts";

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

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  /** Loaded once per process: the manifests ship with the build, so they
   *  change only on deploy or reload. */
  let loaded: Promise<CatalogLoad> | undefined;
  const catalog = (): Promise<CatalogLoad> => (loaded ??= loadCatalog());

  const mcp = (): CatalogMcpService => host.services.require(MCP_SERVICE);
  const ledger = (space: SpaceContext) =>
    createInstallLedger(host.spaceStorage(space).packageDir(host.pluginId));

  /** Live servers that match a catalog entry, plus what the ledger owns. */
  const installedFor = (
    space: SpaceContext,
    entries: CatalogLoad["entries"],
    projectId?: string,
  ): InstalledIntegration[] => {
    const service = mcp();
    let spaceServers: LiveInstallation[] = [];
    let personalServers: LiveInstallation[] = [];
    try {
      spaceServers = service.list(space, projectId);
      personalServers = service.listPersonal(space);
    } catch {
      // A Space where MCP is unavailable still shows the catalog.
      return [];
    }
    return installedFrom(entries, spaceServers, personalServers, ledger(space).list());
  };

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
    if (mark.format === "svg" && /<script|<foreignObject|on[a-z]+\s*=|<iframe/i.test(body.toString("utf8"))) {
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
        json(200, {
          entries: load.entries,
          problems: load.problems,
          stats: catalogStats(load.entries),
          installed: installedFor(rc.space, load.entries, projectId),
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
      const plan = planInstall(entry, {
        ...(typeof body.token === "string" ? { token: body.token } : {}),
        ...(requestedScope ? { scope: requestedScope } : {}),
      });
      if (!plan.ok) {
        json(plan.failure === "unknown-entry" ? 404 : 400, {
          error: plan.failure,
          message: plan.message,
        });
        return true;
      }
      try {
        const created = plan.scope === "person"
          ? await mcp().createPersonal(rc.space, plan.input)
          : await mcp().create(rc.space, plan.input, plan.scope === "project" ? projectId : undefined);
        store.add({
          entryId: entry!.id,
          serverId: created.id,
          scope: plan.scope,
          ...(plan.scope === "project" && projectId ? { projectId } : {}),
          at: Date.now(),
        });
        json(200, {
          installed: installedFor(rc.space, load.entries, projectId).find((row) => row.serverId === created.id) ?? {
            entryId: entry!.id,
            serverId: created.id,
            name: serverNameFor(entry!),
            scope: plan.scope,
            revision: created.revision ?? 0,
            enabled: created.enabled !== false,
            catalogManaged: true,
          },
          notes: plan.notes,
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
      store.forget(record.serverId);
    }
    json(200, { removed, installed: installedFor(rc.space, load.entries, projectId) });
    return true;
  };

  return {
    routes,
    remoteAccess: localOnlyRemoteAccess([INTEGRATION_CATALOG_PACKAGE_ID]),
  };
}
