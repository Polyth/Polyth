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

// An unreadable registry means "we could not read the projects", never "there
// are no projects". Booting empty is survivable; writing that emptiness back
// over the only copy of the user's registry is not.
test("an unreadable project registry is preserved instead of overwritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-projects-"));
  const root = join(dir, "workspace");
  mkdirSync(root);
  const file = join(dir, "projects.json");
  writeFileSync(file, '[{"id":"kept","path":"/somewhere","name":"Important"} <<< truncated');

  const projects = createProjectService(dir);
  assert.deepEqual(await projects.list(), [], "an unreadable registry starts empty in memory");
  assert.equal(
    readFileSync(file, "utf8").includes("Important"),
    true,
    "loading never rewrites the file",
  );

  // The first write is what used to destroy it.
  await projects.add(root, "New");

  const quarantined = readdirSync(dir).filter((name) => name.startsWith("projects.json.unreadable-"));
  assert.equal(quarantined.length, 1, "the unreadable registry is moved aside, not deleted");
  assert.match(readFileSync(join(dir, quarantined[0]!), "utf8"), /Important/);
  assert.equal((await projects.list()).length, 1);
  assert.doesNotMatch(readFileSync(file, "utf8"), /Important/);

  // Only the first write quarantines; later writes are ordinary.
  await projects.add(join(dir, "workspace"), "Again");
  assert.equal(readdirSync(dir).filter((name) => name.startsWith("projects.json.unreadable-")).length, 1);
});

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
  const storedSvg = (await projects.update!(project.id, { icon: svg })).icon ?? "";
  assert.match(storedSvg, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(storedSvg.split(",", 2)[1] ?? "", "base64").toString("utf8"), /<circle cx="5"/);
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

test("project appearance accepts sanitised Iconify SVG data urls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-projects-"));
  const root = join(dir, "workspace");
  mkdirSync(root);
  const projects = createProjectService(dir);
  const project = await projects.add(root);
  const icon = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><metadata id="polyth-iconify">ph:folder</metadata><path fill="currentColor" d="M0 0h1v1H0z"/></svg>');
  const stored = (await projects.update!(project.id, { icon })).icon ?? "";
  assert.match(stored, /^data:image\/svg\+xml;base64,/);
  const decoded = Buffer.from(stored.split(",", 2)[1] ?? "", "base64").toString("utf8");
  assert.match(decoded, /polyth-iconify/);
  assert.match(decoded, /ph:folder/);
  assert.match(decoded, /xmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/);
  assert.match(decoded, /currentColor/i);
});

test("project appearance PATCH materializes picker Iconify handles into safe SVG data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-projects-"));
  const root = join(dir, "workspace");
  mkdirSync(root);
  const projects = createProjectService(dir);
  const tenancy = await testTenancy({ dataDir: dir, projects });
  const project = await projects.forSpace(tenancy.defaultContext).add(root, "Before");
  const fetchImpl = async (input: string | URL | Request) => {
    assert.match(String(input), /https:\/\/api\.iconify\.design\/ph\/folder\.svg/);
    return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M0 0h1v1H0z"/></svg>', { status: 200 });
  };
  const server = createHttpServer({
    sessions: {} as never,
    spaces: tenancy.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist: dir,
    version: "test",
    routes: [projectRoutes(tenancy.services, fetchImpl)],
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ icon: "iconify:ph:folder", color: "#b4532a" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { icon?: string };
    assert.match(body.icon ?? "", /^data:image\/svg\+xml;base64,/);
    assert.doesNotMatch(body.icon ?? "", /iconify:ph:folder/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
    assert.deepEqual(await response.json(), {
      ...project,
      name: "After",
      icon: pngDataUrl,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("adding an already-registered path returns the existing project without rewriting it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-projects-"));
  const root = join(dir, "workspace");
  mkdirSync(root);
  const projects = createProjectService(dir);
  const first = await projects.add(root, "Original");
  const second = await projects.add(root, "Ignored");
  assert.equal(second.id, first.id);
  assert.equal(second.name, "Original");
  assert.equal(second.createdAt, first.createdAt);
  assert.equal("projectTypeId" in second, false);
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
