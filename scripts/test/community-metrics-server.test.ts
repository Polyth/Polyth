import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { basicPassword, createHandler, hashPassword, parsePasswordLine, renderDashboardCsv, renderDashboardHtml, verifyPassword } from "../community-metrics-server.mjs";

const snapshot = (day: string, installers: number, feed: number) => ({
  day,
  takenAt: `${day}T06:10:00Z`,
  repo: { stars: 3, forks: 1 },
  npm: { lastDay: 5 },
  releases: {
    "v1.0.0": { installers, feed, channel: "stable", published: "2026-11-01", platforms: { mac: installers }, feedChannels: { stable: feed } },
    "<b>x</b>": { installers: 0, feed: 0, channel: "stable", published: "2026-11-02", platforms: {}, feedChannels: {} },
  },
});

const fixture = (withPassword = true) => {
  const root = mkdtempSync(join(tmpdir(), "metrics-"));
  const keys = join(root, "keys");
  const data = join(root, "data");
  mkdirSync(keys);
  mkdirSync(data);
  if (withPassword) writeFileSync(join(keys, "password.scrypt"), `${hashPassword("s3cret-pass")}\n`);
  writeFileSync(join(data, "snapshots.jsonl"), [snapshot("2026-11-24", 10, 40), snapshot("2026-11-25", 14, 80)].map((l) => JSON.stringify(l)).join("\n"));
  writeFileSync(join(data, "events.json"), JSON.stringify([{ day: "2026-11-24", label: "<i>Launch</i>" }]));
  writeFileSync(join(data, "goals.json"), JSON.stringify([{ month: "2026-11", metric: "downloads", target: 10 }]));
  writeFileSync(join(data, "weekly.json"), JSON.stringify({ from: "2026-11-24", to: "2026-11-24", writtenAt: "2026-11-25T07:00:00Z", uk: ["<script>x</script> **4**"] }));
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

const now = Date.parse("2026-11-25T09:00:00Z");
const two = () => [snapshot("2026-11-24", 10, 40), snapshot("2026-11-25", 14, 80)] as never;

test("the page escapes data, carries no script and says what the numbers are not", () => {
  const html = renderDashboardHtml(two(), { now, events: [{ day: "2026-11-24", label: "<i>Launch</i>" }] });
  assert.ok(!/<script/i.test(html));
  assert.ok(!/ on\w+=/i.test(html));
  assert.ok(!html.includes("<b>x</b>") && !html.includes("<i>Launch</i>"));
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(html.includes("&lt;i&gt;Launch&lt;/i&gt;"));
  assert.match(html, /<html lang="uk">/);
  // The Polyth mark is inlined (header and favicon): the page still loads nothing.
  assert.match(html, /<header><img class="logo" src="data:image\/png;base64,[A-Za-z0-9+/]+=*" width="34" height="34" alt="">/);
  assert.match(html, /<link rel="icon" type="image\/png" href="data:image\/png;base64,/);
  assert.ok(!/(src|href)="(https?:)?\/\//.test(html));
  assert.match(html, /не стежить за людьми/);
  assert.match(html, /чому це не «кількість користувачів»/);
  // One day of counting: four downloads, no week-on-week claim yet.
  assert.match(html, /За 1 день обліку Polyth завантажили <strong>4 рази<\/strong>\./);
  assert.match(html, /class="status wait"/);
  assert.match(html, /Оновлено сьогодні о 08:10/);
  assert.match(html, /href="\?lang=uk&amp;export=csv"/);
  const english = renderDashboardHtml(two(), { now, lang: "en" });
  assert.match(english, /<html lang="en">/);
  assert.match(english, /does not track people/);
  assert.match(english, /Polyth was downloaded <strong>4 times<\/strong>/);
  assert.match(renderDashboardHtml([]), /Ще немає даних/);
  assert.match(renderDashboardHtml(two(), { now: now + 3 * 86_400_000 }), /dot stale/);
});

test("the weekly note and the month's goal: escaped, bold only from **, stale after nine days, the other language as a fallback", () => {
  const note = { from: "2026-11-17", to: "2026-11-23", writtenAt: "2026-11-24T07:00:00.000Z", uk: ["<b>Ура</b> **81 раз** і *ще*", "Другий"] };
  const goals = [{ month: "2026-11", metric: "downloads", target: 10 }];
  const html = renderDashboardHtml(two(), { now, note, goals });
  assert.ok(html.includes("&lt;b&gt;Ура&lt;/b&gt; <strong>81 раз</strong> і *ще*"));
  assert.match(html, /Підсумок тижня/);
  assert.match(html, /Агент Polyth · 17–23 листопада/);
  assert.ok(!html.includes("Новий підсумок ще не надійшов"));
  // One November day counted (4 downloads), six days left, counting began inside the month.
  assert.match(html, /Ціль на листопад/);
  assert.match(html, /<strong>4<\/strong> з 10/);
  assert.match(html, /До кінця місяця 6 днів\./);
  assert.match(html, /Облік почався 24 листопада/);
  assert.match(html, /Збираємо дані/);
  assert.match(html, /Ще 6 за 6 днів, це ≈ 1 на день\./);
  assert.match(html, /<section class="brief">/);
  // An English page keeps a Ukrainian-only note in its own language.
  const english = renderDashboardHtml(two(), { now, lang: "en", note, goals });
  assert.match(english, /<ol class="nlist" lang="uk">/);
  assert.match(english, /Goal for November/);
  assert.match(renderDashboardHtml(two(), { now: now + 10 * 86_400_000, note }), /Новий підсумок ще не надійшов/);
  // Several goals: both cards span the row. No note and no goal: no row.
  assert.match(renderDashboardHtml(two(), { now, note, goals: [...goals, { month: "2026-11", metric: "stars", target: 5 }] }), /<section class="brief one">/);
  assert.ok(!renderDashboardHtml(two(), { now }).includes('class="brief'));
  assert.ok(!renderDashboardHtml(two(), { now, goals: [{ month: "2026-12", metric: "downloads", target: 10 }] }).includes('class="brief'));
});

test("the CSV download is the daily series with translated headers and a BOM", () => {
  const csv = renderDashboardCsv(two(), { lang: "uk" });
  assert.ok(csv.startsWith("\uFEFFДата,Завантаження,"));
  assert.match(csv, /\r\n2026-11-24,4,4,0,4,0,0,0,0,0,0,40,10,5,no\r\n$/);
  assert.ok(renderDashboardCsv(two(), { lang: "en" }).startsWith("\uFEFFDate,Downloads,"));
});

test("closed by default: no password file, wrong password, lockout, then the page", async (context) => {
  const closed = fixture(false);
  const open = fixture();
  const servers: Server[] = [];
  // A failed assertion must not leave a listening server behind (node:test would wait for it forever).
  context.after(() => {
    for (const server of servers) { server.closeAllConnections(); server.close(); }
    rmSync(closed.root, { recursive: true, force: true });
    rmSync(open.root, { recursive: true, force: true });
  });
  const a = await listen(createHandler({ keysDir: closed.keys, dataDir: closed.data }));
  servers.push(a.server);
  assert.equal((await fetch(a.url, { headers: basic("s3cret-pass") })).status, 503);

  let t = 1_000_000;
  const b = await listen(createHandler({ keysDir: open.keys, dataDir: open.data, now: () => t }));
  servers.push(b.server);
  const anonymous = await fetch(b.url);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate") ?? "", /^Basic/);
  const page = await fetch(b.url, { headers: basic("s3cret-pass") });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  // Images only from data: URLs (the inlined mark), never from the network; still no script source.
  assert.match(csp, /img-src data:;/);
  assert.ok(!/script-src|img-src[^;]*(https?:|\*|'self')/.test(csp));
  const html = await page.text();
  assert.match(html, /Polyth · Статистика/);
  assert.ok(html.includes("&lt;i&gt;Launch&lt;/i&gt;"));
  // goals.json and weekly.json next to the snapshots reach the page, escaped.
  assert.match(html, /Ціль на листопад/);
  assert.ok(html.includes("&lt;script&gt;x&lt;/script&gt; <strong>4</strong>"));
  const english = await fetch(`${b.url}/?lang=en`, { headers: basic("s3cret-pass") });
  assert.match(await english.text(), /Polyth · Statistics/);
  assert.match(await (await fetch(`${b.url}/?lang=xx`, { headers: basic("s3cret-pass") })).text(), /<html lang="uk">/);
  const csv = await fetch(`${b.url}/?export=csv&lang=en`, { headers: basic("s3cret-pass") });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type") ?? "", /^text\/csv/);
  assert.equal(csv.headers.get("content-disposition"), 'attachment; filename="polyth-statistics-2026-11-25.csv"');
  assert.equal(csv.headers.get("cache-control"), "no-store");
  // text() would drop the BOM, so the bytes are checked.
  assert.ok(Buffer.from(await csv.arrayBuffer()).toString("utf8").startsWith("\uFEFFDate,Downloads,"));
  const anonymousCsv = await fetch(`${b.url}/?export=csv`);
  assert.equal(anonymousCsv.status, 401);
  const prompt = await anonymousCsv.text();
  assert.match(prompt, /Потрібен пароль команди/);
  assert.match(prompt, /<img class="logo" src="data:image\/png;base64,/);
  assert.ok(!prompt.includes("2026-11-24"));
  assert.equal((await fetch(`${b.url}/healthz`)).status, 401);
  assert.equal((await fetch(`${b.url}/healthz`, { headers: basic("s3cret-pass") })).status, 200);
  assert.equal((await fetch(`${b.url}/other`, { headers: basic("s3cret-pass") })).status, 404);
  assert.equal((await fetch(b.url, { method: "POST", headers: basic("s3cret-pass") })).status, 405);
  assert.match(await (await fetch(`${b.url}/robots.txt`)).text(), /Disallow: \//);

  for (let i = 0; i < 10; i += 1) assert.equal((await fetch(b.url, { headers: basic("nope") })).status, 401);
  assert.equal((await fetch(b.url, { headers: basic("s3cret-pass") })).status, 429);
  t += 16 * 60_000;
  assert.equal((await fetch(b.url, { headers: basic("s3cret-pass") })).status, 200);
});
