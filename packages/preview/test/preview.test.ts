// Preview service tests: script detection + status transitions against real
// localhost servers (no external network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPreviewService,
  detectPreviewCommand,
  mergePreviewUrls,
  parseAnnouncedUrls,
  parseLsofListeners,
  parseProcNetTcpListeners,
} from "../src/index.ts";

const SERVER_JS = `
const http = require("node:http");
http.createServer((_q, s) => s.end("ok")).listen(process.env.PORT, "127.0.0.1");
`;

async function fixture(
  scripts: Record<string, string>,
  extra: { packageManager?: string; lockfile?: string } = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "polyth-preview-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({
    scripts,
    ...(extra.packageManager ? { packageManager: extra.packageManager } : {}),
  }));
  if (extra.lockfile) await writeFile(join(dir, extra.lockfile), "");
  await writeFile(join(dir, "server.js"), SERVER_JS);
  return dir;
}

async function waitStatus(service: ReturnType<typeof createPreviewService>, id: string, status: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (service.get(id).status !== status) {
    if (Date.now() - start > timeoutMs) throw new Error(`status never became ${status}, got ${service.get(id).status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("detects dev > start > serve and reaches running with a free port", async () => {
  const dir = await fixture({ start: "node server.js" });
  try {
    const s = createPreviewService();
    assert.deepEqual(s.get("p1"), { url: null, status: "off" });

    const { url, port } = await s.start("p1", { cwd: dir });
    assert.ok(port > 0);
    assert.equal(url, `http://127.0.0.1:${port}/`);
    assert.equal(s.get("p1").status, "starting");

    await waitStatus(s, "p1", "running");
    assert.equal(s.get("p1").url, url);
    assert.equal(s.get("p1").command, "npm run start");

    await s.stop("p1");
    assert.equal(s.get("p1").status, "off");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("script order: dev wins over start/serve", async () => {
  const dir = await fixture({ dev: "node server.js", serve: "node server.js" });
  try {
    const s = createPreviewService();
    await s.start("p2", { cwd: dir });
    assert.equal(s.get("p2").command, "npm run dev");
    await s.stop("p2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("package manager and broader preview-script detection follow project metadata", async () => {
  const pnpm = await fixture({ preview: "vite preview", serve: "serve ." }, { lockfile: "pnpm-lock.yaml" });
  const yarn = await fixture({ develop: "next dev" }, { packageManager: "yarn@4.9.1" });
  try {
    assert.deepEqual(await detectPreviewCommand(pnpm), {
      command: "pnpm run preview",
      packageManager: "pnpm",
      script: "preview",
    });
    assert.deepEqual(await detectPreviewCommand(yarn), {
      command: "yarn develop",
      packageManager: "yarn",
      script: "develop",
    });
  } finally {
    await Promise.all([pnpm, yarn].map((dir) => rm(dir, { recursive: true, force: true })));
  }
});

test("announced URLs and /proc listeners normalize to loopback and merge without unrelated ports", () => {
  assert.deepEqual(parseAnnouncedUrls([
    "\u001b[32mLocal: http://localhost:5173/app\u001b[0m",
    "Network: http://192.168.1.20:5173/",
    "IPv6 wildcard: http://[::]:6173/ui",
    "Credentials: http://user:secret@localhost:7199/private",
    "ready at 127.0.0.1:4173",
  ].join("\n")), [
    "http://127.0.0.1:5173/app",
    "http://127.0.0.1:6173/ui",
    "http://127.0.0.1:4173/",
  ]);
  const proc = [
    " sl  local_address rem_address   st",
    " 0: 0100007F:1435 00000000:0000 0A",
    " 1: 00000000:104D 00000000:0000 0A",
    " 2: 1401A8C0:1F90 00000000:0000 0A",
    " 3: 0100007F:1770 00000000:0000 01",
  ].join("\n");
  assert.deepEqual(parseProcNetTcpListeners(proc), [4173, 5173]);
  assert.deepEqual(parseLsofListeners([
    "n*:4173",
    "n127.0.0.1:5173",
    "n[::1]:5173",
    "n192.168.1.20:8080",
    "n127.0.0.1:9000->127.0.0.1:50000",
  ].join("\n")), [4173, 5173]);
  assert.deepEqual(mergePreviewUrls({
    announced: [
      "http://127.0.0.1:5173/app",
      "http://127.0.0.1:8000/not-listening",
      "http://127.0.0.1:9000/pre-existing",
    ],
    listenerPorts: new Set([4173, 5173, 9000]),
    baselinePorts: new Set([9000]),
    expectedPort: 4173,
  }), [
    "http://127.0.0.1:5173/app",
    "http://127.0.0.1:4173/",
    "http://127.0.0.1:5173/",
  ]);
});

test("process output can promote a server that ignores PORT and announces its real URL", async () => {
  const dir = await fixture({ dev: "node announced.js" });
  await writeFile(join(dir, "announced.js"), `
const http = require("node:http");
const server = http.createServer((_q, response) => response.end("ok"));
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log("Local: http://localhost:" + address.port + "/app");
});
`);
  try {
    const service = createPreviewService();
    const initial = await service.start("announced", { cwd: dir });
    await waitStatus(service, "announced", "running");
    const state = service.get("announced");
    assert.notEqual(state.port, initial.port, "fixture deliberately ignored the supplied PORT");
    assert.equal(state.url, `http://127.0.0.1:${state.port}/app`);
    assert.ok(state.urls?.includes(state.url!));
    await service.stop("announced");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit command overrides detection", async () => {
  const dir = await fixture({ serve: "node server.js" });
  try {
    const s = createPreviewService();
    await s.start("p3", { cwd: dir, command: "node server.js" });
    assert.equal(s.get("p3").command, "node server.js");
    await waitStatus(s, "p3", "running");
    await s.stop("p3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no script and no command -> invalid-input error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-preview-"));
  try {
    const s = createPreviewService();
    await assert.rejects(() => s.start("p4", { cwd: dir }), (err: Error & { code?: string }) => err.code === "invalid-input");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("start is idempotent while running; status change callbacks fire", async () => {
  const dir = await fixture({ dev: "node server.js" });
  try {
    const s = createPreviewService();
    const seen: string[] = [];
    s.onStatusChange((id, st) => { if (id === "p5") seen.push(st.status); });

    const first = await s.start("p5", { cwd: dir });
    await waitStatus(s, "p5", "running");
    const second = await s.start("p5", { cwd: dir });
    assert.deepEqual(second, first, "already-running start returns the same url/port");
    assert.ok(seen.includes("running"), "status change callback fired");
    await s.stop("p5");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
