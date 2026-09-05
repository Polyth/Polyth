import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpServer } from "../src/http.ts";
import { createProjectService } from "../src/projects.ts";
import { projectRoutes } from "../src/routes/projects.ts";
import { testTenancy } from "./support/spaces.ts";

const pngDataUrl = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}`;
const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

test("project appearance accepts safe uploaded PNG and standard SVG icons", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-projects-"));
  const root = join(dir, "workspace");
  mkdirSync(root);
  const projects = createProjectService(dir);
  const project = await projects.add(root, "Before");

  const png = await projects.update!(project.id, { name: "After", icon: pngDataUrl, color: "#123abc" });
  assert.equal(png.name, "After");
  assert.equal(png.icon, pngDataUrl);

  const svg = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>');
  assert.equal((await projects.update!(project.id, { icon: svg })).icon, svg);
  assert.equal(
    (await projects.update!(project.id, { icon: "/assets/project-icons/folder.svg" })).icon,
    "/assets/project-icons/folder.svg",
  );
});

test("project appearance rejects unsafe SVG icons", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-projects-"));
  const root = join(dir, "workspace");
  mkdirSync(root);
  const projects = createProjectService(dir);
  const project = await projects.add(root);
  const unsafe = svgDataUrl("<svg><script>alert(1)</script></svg>");
  await assert.rejects(() => projects.update!(project.id, { icon: unsafe }), /safe SVG/);
});

test("project metadata PATCH is served by the project route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-projects-"));
  const root = join(dir, "workspace");
  mkdirSync(root);
  const projects = createProjectService(dir);
  const tenancy = await testTenancy({ dataDir: dir, projects });
  // Registered before tenancy existed: the boot migration adopts it, and the
  // PATCH below therefore resolves through the caller's own Space.
  const project = await projects.forSpace(tenancy.defaultContext).add(root, "Before");
  const server = createHttpServer({
    sessions: {} as never,
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist: dir,
    version: "test",
    routes: [projectRoutes(tenancy.services)],
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "After", icon: pngDataUrl }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...project, name: "After", icon: pngDataUrl });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("project model memory is persisted without erasing the remembered model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-projects-"));
  const root = join(dir, "workspace");
  mkdirSync(root);
  const projects = createProjectService(dir);
  const project = await projects.add(root);
  const model = { providerID: "openai", modelID: "gpt-5" };

  const enabled = await projects.update!(project.id, {
    defaults: { rememberModelSelection: true, model },
  });
  assert.deepEqual(enabled.defaults, { rememberModelSelection: true, model });

  const disabled = await projects.update!(project.id, {
    defaults: { rememberModelSelection: false },
  });
  assert.deepEqual(disabled.defaults, { rememberModelSelection: false, model });

  const reloaded = createProjectService(dir);
  assert.deepEqual((await reloaded.get!(project.id))?.defaults, {
    rememberModelSelection: false,
    model,
  });
  await assert.rejects(
    () => reloaded.update!(project.id, {
      defaults: { rememberModelSelection: "yes" } as never,
    }),
    /rememberModelSelection must be boolean/,
  );
});

test("projects.json writes are atomic and corrupt files are not overwritten on load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-projects-"));
  const root = join(dir, "workspace");
  mkdirSync(root);
  const file = join(dir, "projects.json");

  // Happy path: persist via tmp+rename leaves a valid JSON array and no .tmp.
  const projects = createProjectService(dir);
  await projects.add(root, "Alpha");
  assert.equal(readFileSync(file, "utf8").trim().startsWith("["), true);
  assert.equal(
    readdirSync(dir).some((n) => n.includes(".tmp")),
    false,
  );

  // Corrupt on-disk file: boot with empty in-memory registry; leave file as-is.
  writeFileSync(file, "{not-valid-json");
  const before = readFileSync(file, "utf8");
  const recovered = createProjectService(dir);
  assert.deepEqual(await recovered.list(), []);
  assert.equal(readFileSync(file, "utf8"), before, "corrupt file must not be rewritten on load");
});
