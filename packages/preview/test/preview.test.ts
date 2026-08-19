// Preview service tests: script detection + status transitions against real
// localhost servers (no external network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPreviewService } from "../src/index.ts";

const SERVER_JS = `
const http = require("node:http");
http.createServer((_q, s) => s.end("ok")).listen(process.env.PORT, "127.0.0.1");
`;

async function fixture(scripts: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "polyth-preview-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ scripts }));
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
    assert.equal(url, `http://127.0.0.1:${port}`);
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
