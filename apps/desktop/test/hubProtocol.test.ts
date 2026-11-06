import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { hubContentSecurityPolicy, hubResponse, resolveHubFile } from "../src/hubProtocol.ts";

const INLINE = "window.a=1;";
const INDEX = `<!doctype html><script>${INLINE}</script><script type="module" src="/main.js"></script><script type="importmap">{"imports":{}}</script>`;
let dir = "";
let dist = "";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "polyth-hub-"));
  dist = join(dir, "web");
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(dist, "index.html"), INDEX);
  await writeFile(join(dist, "main.js"), "export {};");
  await writeFile(join(dist, "main.css"), "a{}");
  await writeFile(join(dist, "assets", "font.woff2"), "x");
  await writeFile(join(dir, "secret.txt"), "secret");
  if (process.platform !== "win32") await symlink(join(dir, "secret.txt"), join(dist, "linked.txt"));
});
after(() => rm(dir, { recursive: true, force: true }));

test("the list's document allows only this build's scripts", () => {
  const policy = hubContentSecurityPolicy(INDEX);
  const hash = createHash("sha256").update(INLINE).digest("base64");
  assert.match(policy, new RegExp(`script-src 'self' 'sha256-${hash.replace(/[+/]/g, "\\$&")}'`));
  assert.match(policy, /connect-src 'self'(;|$)/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'none'/);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
  // An empty external <script src> contributes no hash.
  assert.equal([...policy.matchAll(/sha256-/g)].length, 2);
});

test("only files of the shell resolve", async () => {
  assert.equal(await resolveHubFile(dist, "/"), join(dist, "index.html").replace(dist, await realDist()));
  assert.ok((await resolveHubFile(dist, "/main.js"))?.endsWith("main.js"));
  assert.ok((await resolveHubFile(dist, "/assets/font.woff2"))?.endsWith("font.woff2"));
  for (const bad of ["/../secret.txt", "/assets/../../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/a\\b", "/%5c..%5csecret.txt", "/%00", "/%ZZ", "/missing.js", "/p/project/s/session"]) {
    assert.equal(await resolveHubFile(dist, bad), null, bad);
  }
  if (process.platform !== "win32") assert.equal(await resolveHubFile(dist, "/linked.txt"), null);
});

async function realDist(): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(dist);
}

test("answers carry a real type, and the document carries the policy", async () => {
  const index = await hubResponse(dist, { url: "polyth-app://hub/?add=1", method: "GET" });
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") ?? "", /text\/html/);
  assert.match(index.headers.get("content-security-policy") ?? "", /script-src/);
  assert.equal(await index.text(), INDEX);
  const script = await hubResponse(dist, { url: "polyth-app://hub/main.js", method: "GET" });
  assert.match(script.headers.get("content-type") ?? "", /text\/javascript/);
  assert.equal(script.headers.get("content-security-policy"), null);
  assert.match((await hubResponse(dist, { url: "polyth-app://hub/main.css", method: "GET" })).headers.get("content-type") ?? "", /text\/css/);
});

test("nothing else answers on this origin", async () => {
  assert.equal((await hubResponse(dist, { url: "polyth-app://other/main.js", method: "GET" })).status, 404);
  assert.equal((await hubResponse(dist, { url: "polyth-app://hub/api/auth/status", method: "GET" })).status, 404);
  assert.equal((await hubResponse(dist, { url: "polyth-app://hub/main.js", method: "POST" })).status, 405);
  assert.equal((await hubResponse(dist, { url: "not a url", method: "GET" })).status, 404);
});
