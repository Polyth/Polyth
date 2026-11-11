import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RouteRequest, SpaceContext } from "@polyth/contracts";
import {
  bindPackageServices,
  createServerServiceRegistry,
  serverServiceKey,
  type ServerPackageHost,
} from "@polyth/plugins";
import registerPackage, {
  ENTRIES_PATH,
  INSTALL_PATH,
  LOGO_PATH,
  UNINSTALL_PATH,
  type CatalogMcpService,
} from "../src/serverEntry.ts";
import type { CatalogPayload } from "../src/catalog.ts";
import type { InstalledIntegration, McpInstallInput } from "../src/install.ts";
import type { IntegrationManifest } from "../src/manifest.ts";

const space: SpaceContext = {
  spaceId: "space-1",
  spaceSlug: "space-1",
  userId: "u1",
  role: "admin",
  deployment: "local-trusted",
  storageDir: "/tmp/does-not-matter",
} as SpaceContext;

interface Call {
  method: string;
  path: string;
  /** Query string without `?`; the gateway keeps it out of `path`. */
  query?: string;
  body?: Record<string, unknown>;
}

interface Harness {
  call(input: Call): Promise<{ handled: boolean; status: number; body: unknown; raw?: { type: string; bytes: Buffer } }>;
  created: Array<{ input: McpInstallInput; projectId?: string; personal: boolean }>;
  removed: Array<{ id: string; projectId?: string; personal: boolean }>;
  servers: Array<{ id: string; name: string; revision?: number; enabled?: boolean; projectId?: string }>;
  personal: Array<{ id: string; name: string; revision?: number; enabled?: boolean }>;
  ledger(): Promise<{ installs: Array<{ entryId: string; serverId: string; scope: string }> }>;
  /** Make the MCP service throw on list, as a Space without MCP does. */
  failList: boolean;
}

/** A host with the one service this package uses, a temp Space directory and
 *  an MCP service that records what it was asked to do. */
async function harness(t: { after(fn: () => unknown): void }): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "integration-catalog-routes-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const created: Harness["created"] = [];
  const removed: Harness["removed"] = [];
  const servers: Harness["servers"] = [];
  const personal: Harness["personal"] = [];
  let nextId = 1;

  const state = { failList: false };
  const service: CatalogMcpService = {
    list: (_space, projectId) => {
      if (state.failList) throw Object.assign(new Error("MCP is unavailable"), { code: "storage-unavailable" });
      return servers.filter((server) => !projectId || server.projectId === projectId);
    },
    listPersonal: () => personal,
    async create(_space, input, projectId) {
      if (servers.some((server) => server.name === input.name)) {
        throw Object.assign(new Error(`an MCP server named "${input.name}" already exists`), { code: "conflict" });
      }
      created.push({ input, ...(projectId ? { projectId } : {}), personal: false });
      const row = { id: `srv-${nextId++}`, name: input.name, revision: 1, enabled: true, ...(projectId ? { projectId } : {}) };
      servers.push(row);
      return row;
    },
    async createPersonal(_space, input) {
      created.push({ input, personal: true });
      const row = { id: `per-${nextId++}`, name: input.name, revision: 1, enabled: true };
      personal.push(row);
      return row;
    },
    async remove(_space, id, projectId) {
      removed.push({ id, ...(projectId ? { projectId } : {}), personal: false });
      const index = servers.findIndex((server) => server.id === id);
      if (index >= 0) servers.splice(index, 1);
      return index >= 0;
    },
    async removePersonal(_space, id) {
      removed.push({ id, personal: true });
      const index = personal.findIndex((server) => server.id === id);
      if (index >= 0) personal.splice(index, 1);
      return index >= 0;
    },
  };

  const services = createServerServiceRegistry();
  services.provide(serverServiceKey<CatalogMcpService>("mcp.project"), service);
  const host = {
    pluginId: "integration-catalog",
    services: bindPackageServices(services, "integration-catalog"),
    spaceStorage: (ctx: SpaceContext) => ({
      packageDir: (id: string) => join(root, ctx.spaceId, id),
    }),
  } as unknown as ServerPackageHost;

  const pkg = registerPackage(host);
  assert.ok(pkg.routes);

  return {
    created,
    removed,
    servers,
    personal,
    get failList() { return state.failList; },
    set failList(value: boolean) { state.failList = value; },
    async ledger() {
      const raw = await readFile(join(root, "space-1", "integration-catalog", "installs.json"), "utf8");
      return JSON.parse(raw) as { installs: Array<{ entryId: string; serverId: string; scope: string }> };
    },
    async call({ method, path, query = "", body = {} }) {
      let status = 0;
      let payload: unknown;
      let raw: { type: string; bytes: Buffer } | undefined;
      const rc = {
        path,
        method,
        url: new URL(`http://polyth.test${path}${query ? `?${query}` : ""}`),
        principal: { kind: "local-user" },
        space,
        requireCapability() {},
        body: async () => body,
        json(code: number, value: unknown) {
          status = code;
          payload = value;
        },
        res: {
          writeHead(code: number, headers: Record<string, string>) {
            status = code;
            type = headers["content-type"] ?? "";
          },
          end(buffer: Buffer) {
            raw = { type: "", bytes: buffer };
          },
        },
      } as unknown as RouteRequest;
      let type = "";
      const handled = await pkg.routes!(rc);
      if (raw) raw = { type, bytes: raw.bytes };
      return { handled, status, body: payload, ...(raw ? { raw } : {}) };
    },
  };
}

test("the list route answers with entries, stats, connected state and no problems", async (t) => {
  const h = await harness(t);
  const { handled, status, body } = await h.call({ method: "GET", path: ENTRIES_PATH });
  assert.equal(handled, true);
  assert.equal(status, 200);
  const payload = body as CatalogPayload;
  assert.ok(payload.entries.length >= 12);
  assert.deepEqual(payload.problems, []);
  assert.equal(payload.stats.total, payload.entries.length);
  assert.deepEqual(payload.installed, []);
});

test("one entry is addressable by id and unknown ids are a 404", async (t) => {
  const h = await harness(t);
  const found = await h.call({ method: "GET", path: `${ENTRIES_PATH}/linear` });
  assert.equal(found.status, 200);
  const entry = (found.body as { entry: IntegrationManifest }).entry;
  assert.equal(entry.id, "linear");
  assert.equal(entry.mcp.remote?.url, "https://mcp.linear.app/mcp");

  assert.equal((await h.call({ method: "GET", path: `${ENTRIES_PATH}/nope` })).status, 404);
  assert.equal((await h.call({ method: "GET", path: `${ENTRIES_PATH}/linear/extra` })).status, 404);
});

test("the catalog is read-only and does not claim other paths", async (t) => {
  const h = await harness(t);
  const write = await h.call({ method: "POST", path: ENTRIES_PATH });
  assert.equal(write.status, 405);
  const outside = await h.call({ method: "GET", path: "/api/something-else" });
  assert.equal(outside.handled, false);
  assert.equal((await h.call({ method: "GET", path: INSTALL_PATH })).status, 405);
});

test("an OAuth entry installs into the project and is remembered as catalog-managed", async (t) => {
  const h = await harness(t);
  const result = await h.call({
    method: "POST",
    path: INSTALL_PATH,
    body: { entryId: "linear", projectId: "p1" },
  });
  assert.equal(result.status, 200);
  assert.equal(h.created.length, 1);
  assert.deepEqual(h.created[0]!.input.transport, {
    kind: "http",
    url: "https://mcp.linear.app/mcp",
    headersSecretRefs: [],
  });
  assert.equal(h.created[0]!.projectId, "p1");
  assert.equal(h.created[0]!.personal, false);

  const installed = (result.body as { installed: InstalledIntegration }).installed;
  assert.equal(installed.entryId, "linear");
  assert.equal(installed.scope, "project");
  assert.equal(installed.catalogManaged, true);

  const ledger = await h.ledger();
  assert.deepEqual(ledger.installs.map((row) => [row.entryId, row.scope]), [["linear", "project"]]);
});

test("a token entry installs personally with the secret the host stores", async (t) => {
  const h = await harness(t);
  const result = await h.call({
    method: "POST",
    path: INSTALL_PATH,
    body: { entryId: "github", token: "ghp_test", projectId: "p1" },
  });
  assert.equal(result.status, 200);
  assert.equal(h.created[0]!.personal, true);
  assert.deepEqual(h.created[0]!.input.secrets, { Authorization: "Bearer ghp_test" });
  assert.deepEqual(h.created[0]!.input.transport, {
    kind: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headersSecretRefs: ["Authorization"],
  });
  const installed = (result.body as { installed: InstalledIntegration }).installed;
  assert.equal(installed.scope, "person");
});

test("a token entry without a token is a 400; an optional-key entry installs without one", async (t) => {
  const h = await harness(t);
  const missing = await h.call({ method: "POST", path: INSTALL_PATH, body: { entryId: "github" } });
  assert.equal(missing.status, 400);
  assert.match((missing.body as { error: string }).error, /token-required/);
  assert.equal(h.created.length, 0);

  const keyless = await h.call({ method: "POST", path: INSTALL_PATH, body: { entryId: "exa" } });
  assert.equal(keyless.status, 200);
  assert.deepEqual(h.created[0]!.input.transport, { kind: "http", url: "https://mcp.exa.ai/mcp", headersSecretRefs: [] });
  assert.equal(h.created[0]!.personal, true);
});

test("an optional key travels in the header the entry declares", async (t) => {
  const h = await harness(t);
  const keyed = await h.call({ method: "POST", path: INSTALL_PATH, body: { entryId: "exa", token: "exa-key" } });
  assert.equal(keyed.status, 200);
  assert.deepEqual(h.created[0]!.input.secrets, { "x-api-key": "exa-key" });
});

test("a local entry installs the pinned command", async (t) => {
  const h = await harness(t);
  const result = await h.call({ method: "POST", path: INSTALL_PATH, body: { entryId: "playwright", projectId: "p1" } });
  assert.equal(result.status, 200);
  const transport = h.created[0]!.input.transport;
  assert.equal(transport.kind, "stdio");
  assert.equal(transport.kind === "stdio" ? transport.command : "", "npx");
  assert.match(transport.kind === "stdio" ? transport.args.join(" ") : "", /^-y @playwright\/mcp@\d+\.\d+\.\d+$/);
});

test("a chosen site is interpolated, and a value outside the choices is refused", async (t) => {
  const h = await harness(t);
  const eu = await h.call({ method: "POST", path: INSTALL_PATH, body: { entryId: "datadog", projectId: "p1", inputs: { site: "datadoghq.eu" } } });
  assert.equal(eu.status, 200);
  assert.equal(h.created[0]!.input.transport.kind === "http" ? h.created[0]!.input.transport.url : "", "https://mcp.datadoghq.eu/v1/mcp");

  // A host must never come from free text: this would send the sign-in elsewhere.
  for (const site of ["evil.example", "datadoghq.com/../x", "datadoghq.com@evil.example"]) {
    const refused = await h.call({ method: "POST", path: INSTALL_PATH, body: { entryId: "datadog", projectId: "p2", inputs: { site } } });
    assert.equal(refused.status, 400, site);
    assert.equal((refused.body as { error: string }).error, "input-invalid");
  }
  assert.equal(h.created.length, 1);
});

test("a free-text input is checked against its pattern before it reaches the command", async (t) => {
  const h = await harness(t);
  const empty = await h.call({ method: "POST", path: INSTALL_PATH, body: { entryId: "azure-devops", projectId: "p1" } });
  assert.equal(empty.status, 400);
  assert.match((empty.body as { message: string }).message, /Organization is required/);
  const injected = await h.call({ method: "POST", path: INSTALL_PATH, body: { entryId: "azure-devops", projectId: "p1", inputs: { org: "--yes; rm" } } });
  assert.equal(injected.status, 400);
  const ok = await h.call({ method: "POST", path: INSTALL_PATH, body: { entryId: "azure-devops", projectId: "p1", inputs: { org: "contoso" } } });
  assert.equal(ok.status, 200);
  const transport = h.created[0]!.input.transport;
  assert.equal(transport.kind === "stdio" ? transport.args.at(-1) : "", "contoso");
});

test("without an open project an install is recorded for the whole Space", async (t) => {
  const h = await harness(t);
  const result = await h.call({ method: "POST", path: INSTALL_PATH, body: { entryId: "linear" } });
  assert.equal(result.status, 200);
  assert.equal((result.body as { installed: InstalledIntegration }).installed.scope, "space");
  assert.deepEqual((await h.ledger()).installs.map((row) => row.scope), ["space"]);
});

test("the list says when MCP connections cannot be read", async (t) => {
  const h = await harness(t);
  h.failList = true;
  const payload = (await h.call({ method: "GET", path: ENTRIES_PATH })).body as CatalogPayload;
  assert.equal(payload.connections, "unavailable");
  assert.ok(payload.entries.length > 200);
  h.failList = false;
  const healthy = (await h.call({ method: "GET", path: ENTRIES_PATH })).body as CatalogPayload;
  assert.equal(healthy.connections, "ok");
});

test("an unknown entry is a 404 and a duplicate install is a 409", async (t) => {
  const h = await harness(t);
  assert.equal((await h.call({ method: "POST", path: INSTALL_PATH, body: { entryId: "nope" } })).status, 404);

  await h.call({ method: "POST", path: INSTALL_PATH, body: { entryId: "linear", projectId: "p1" } });
  const duplicate = await h.call({ method: "POST", path: INSTALL_PATH, body: { entryId: "linear", projectId: "p1" } });
  assert.equal(duplicate.status, 409);
  assert.equal((duplicate.body as { error: string }).error, "already-installed");
  assert.equal((duplicate.body as { installed: InstalledIntegration }).installed.entryId, "linear");
});

test("the list reports a hand-made server as not catalog-managed", async (t) => {
  const h = await harness(t);
  h.servers.push({ id: "srv-hand", name: "sentry", revision: 1, projectId: "p1" });
  const payload = (await h.call({ method: "GET", path: ENTRIES_PATH, query: "projectId=p1" })).body as CatalogPayload;
  assert.deepEqual(payload.installed.map((row) => [row.entryId, row.catalogManaged]), [["sentry", false]]);
});

test("uninstall removes only what the catalog installed, once", async (t) => {
  const h = await harness(t);
  await h.call({ method: "POST", path: INSTALL_PATH, body: { entryId: "linear", projectId: "p1" } });

  // A hand-made server with a catalog name is not ours to remove.
  h.servers.push({ id: "srv-hand", name: "sentry", revision: 1 });
  const foreign = await h.call({ method: "POST", path: UNINSTALL_PATH, body: { entryId: "sentry" } });
  assert.equal(foreign.status, 404);
  assert.match((foreign.body as { error: string }).error, /not-catalog-managed/);
  assert.deepEqual(h.removed, []);

  const gone = await h.call({ method: "POST", path: UNINSTALL_PATH, body: { entryId: "linear", projectId: "p1" } });
  assert.equal(gone.status, 200);
  assert.equal((gone.body as { removed: number }).removed, 1);
  assert.deepEqual(h.removed, [{ id: "srv-1", projectId: "p1", personal: false }]);
  assert.deepEqual((await h.ledger()).installs, []);

  const again = await h.call({ method: "POST", path: UNINSTALL_PATH, body: { entryId: "linear" } });
  assert.equal(again.status, 404);
});

test("a personal install is removed through the personal path", async (t) => {
  const h = await harness(t);
  await h.call({ method: "POST", path: INSTALL_PATH, body: { entryId: "github", token: "ghp_test" } });
  const gone = await h.call({ method: "POST", path: UNINSTALL_PATH, body: { entryId: "github" } });
  assert.equal(gone.status, 200);
  assert.deepEqual(h.removed, [{ id: "per-1", personal: true }]);
});

test("paired devices are denied by default", async () => {
  const pkg = registerPackage({} as ServerPackageHost);
  assert.ok(pkg.remoteAccess);
  assert.deepEqual(pkg.remoteAccess.http, []);
});

test("a brand mark is served from the vendored assets", async (t) => {
  const h = await harness(t);
  const svg = await h.call({ method: "GET", path: `${LOGO_PATH}/linear` });
  assert.equal(svg.status, 200);
  assert.equal(svg.raw?.type, "image/svg+xml");
  assert.match(svg.raw!.bytes.toString("utf8"), /^<svg[\s>]/);

  const png = await h.call({ method: "GET", path: `${LOGO_PATH}/amplitude` });
  assert.equal(png.status, 200);
  assert.equal(png.raw?.type, "image/png");
  assert.equal(png.raw!.bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

  assert.equal((await h.call({ method: "GET", path: `${LOGO_PATH}/nope` })).status, 404);
  // No traversal and no extension: the id must be a known entry.
  assert.equal((await h.call({ method: "GET", path: `${LOGO_PATH}/../package` })).status, 404);
  assert.equal((await h.call({ method: "GET", path: `${LOGO_PATH}/linear.svg` })).status, 404);
  assert.equal((await h.call({ method: "POST", path: `${LOGO_PATH}/linear` })).status, 405);
});
