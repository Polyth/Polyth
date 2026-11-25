import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { basicPassword, createHandler, hashPassword, parsePasswordLine, renderDashboardHtml, verifyPassword } from "../community-metrics-server.mjs";

const snapshot = (day: string, installers: number, feed: number) => ({
  day,
  repo: { stars: 3, forks: 1 },
  npm: { lastDay: 5 },
  releases: { "v1.0.0": { installers, feed, channel: "stable", published: "2026-11-01" }, "<b>x</b>": { installers: 0, feed: 0, channel: "nightly", published: "2026-11-02" } },
});

const fixture = (withPassword = true) => {
  const root = mkdtempSync(join(tmpdir(), "metrics-"));
  const keys = join(root, "keys");
  const data = join(root, "data");
  mkdirSync(keys);
  mkdirSync(data);
  if (withPassword) writeFileSync(join(keys, "password.scrypt"), `${hashPassword("s3cret-pass")}\n`);
  writeFileSync(join(data, "snapshots.jsonl"), [snapshot("2026-11-24", 10, 40), snapshot("2026-11-25", 14, 80)].map((l) => JSON.stringify(l)).join("\n"));
  return { root, keys, data };
};

const listen = async (handler: Parameters<typeof createServer>[1]) => {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}` };
};
const basic = (password: string) => ({ authorization: `Basic ${Buffer.from(`team:${password}`).toString("base64")}` });

test("passwords hash, parse and verify; bad input is refused", () => {
  const line = hashPassword("s3cret-pass");
  const record = parsePasswordLine(line);
  assert.ok(record);
  assert.equal(verifyPassword(record, "s3cret-pass"), true);
  assert.equal(verifyPassword(record, "wrong"), false);
  assert.equal(verifyPassword(record, ""), false);
  assert.throws(() => hashPassword("has space"));
  assert.equal(parsePasswordLine("scrypt$3$8$1$AAAA$BBBB"), null);
  assert.equal(parsePasswordLine("plain"), null);
  assert.equal(basicPassword(`Basic ${Buffer.from("u:a:b").toString("base64")}`), "a:b");
  assert.equal(basicPassword("Bearer x"), "");
});

test("the page escapes data, carries no script and says what the numbers are not", () => {
  const html = renderDashboardHtml([snapshot("2026-11-24", 10, 40), snapshot("2026-11-25", 14, 80)] as never);
  assert.ok(!/<script/i.test(html));
  assert.ok(!html.includes("<b>x</b>"));
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.match(html, /not telemetry and not user counts/);
  assert.match(html, /<td>\+4<\/td>/);
  assert.match(renderDashboardHtml([]), /No snapshots yet/);
});

test("closed by default: no password file, wrong password, lockout, then the page", async () => {
  const closed = fixture(false);
  const a = await listen(createHandler({ keysDir: closed.keys, dataDir: closed.data }));
  assert.equal((await fetch(a.url, { headers: basic("s3cret-pass") })).status, 503);
  a.server.close();

  const open = fixture();
  let t = 1_000_000;
  const b = await listen(createHandler({ keysDir: open.keys, dataDir: open.data, now: () => t }));
  const anonymous = await fetch(b.url);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate") ?? "", /^Basic/);
  const page = await fetch(b.url, { headers: basic("s3cret-pass") });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(await page.text(), /Polyth community signals/);
  assert.equal((await fetch(`${b.url}/healthz`)).status, 401);
  assert.equal((await fetch(`${b.url}/healthz`, { headers: basic("s3cret-pass") })).status, 200);
  assert.equal((await fetch(`${b.url}/other`, { headers: basic("s3cret-pass") })).status, 404);
  assert.equal((await fetch(b.url, { method: "POST", headers: basic("s3cret-pass") })).status, 405);
  assert.match(await (await fetch(`${b.url}/robots.txt`)).text(), /Disallow: \//);

  for (let i = 0; i < 10; i += 1) assert.equal((await fetch(b.url, { headers: basic("nope") })).status, 401);
  assert.equal((await fetch(b.url, { headers: basic("s3cret-pass") })).status, 429);
  t += 16 * 60_000;
  assert.equal((await fetch(b.url, { headers: basic("s3cret-pass") })).status, 200);
  b.server.close();
  rmSync(closed.root, { recursive: true, force: true });
  rmSync(open.root, { recursive: true, force: true });
});
