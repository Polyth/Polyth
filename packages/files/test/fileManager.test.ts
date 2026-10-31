// File-manager affordances: tree order by
// name/modified/size with matching row metadata, quick-open highlighting,
// guarded uploads, the explicit Download disposition on /api/files/raw, the
// flat listing, folder .zip downloads, CSV tables, the symbol outline and
// which folders a dragged row may move into.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { crc32, inflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectService, RouteRequest, SessionService } from "@polyth/contracts";
import type { FileEntry } from "@polyth/session/web-api";
import { createFileService } from "../src/index.ts";
import { workspaceRoutes } from "../src/serverEntry.ts";
import { entryMeta, formatSize, isTreeSortMode, sortEntries, sortFlat } from "../widgets/editor/treeSort.ts";
import { matchSegments, splitPath } from "../widgets/editor/searchMatch.ts";
import { joinPath, MAX_UPLOAD_BYTES, uploadIntoFolder, validUploadName } from "../widgets/editor/uploads.ts";
import { planArchive } from "../src/archive.ts";
import { guessDelimiter, numericColumns, numericValue, parseCsv, sortRows } from "../widgets/editor/csv.ts";
import { extractSymbols, filterSymbols, hasOutline } from "../widgets/editor/outline.ts";
import { canMoveInto } from "../widgets/editor/treeState.ts";
import { previewKindForPath } from "../widgets/editor/liveFile.ts";

const entry = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({ name, path: name, dir: false, ...extra });

test("sortEntries keeps folders first and orders by name, newest change, or largest size", () => {
  const entries = [
    entry("b.txt", { size: 10, mtime: 300 }),
    entry("src", { dir: true, mtime: 100 }),
    entry("a.txt", { size: 500, mtime: 100 }),
    entry("docs", { dir: true, mtime: 900 }),
    entry("c.txt", { size: 10 }),
  ];
  assert.deepEqual(sortEntries(entries, "name").map((item) => item.name), ["docs", "src", "a.txt", "b.txt", "c.txt"]);
  assert.deepEqual(sortEntries(entries, "modified").map((item) => item.name), ["docs", "src", "b.txt", "a.txt", "c.txt"]);
  assert.deepEqual(sortEntries(entries, "size").map((item) => item.name), ["docs", "src", "a.txt", "b.txt", "c.txt"]);
  assert.equal(entries[0]!.name, "b.txt", "sorting never mutates the listing");
  assert.equal(isTreeSortMode("size"), true);
  assert.equal(isTreeSortMode("type"), false);
});

test("row metadata shows the value the tree is ordered by", () => {
  const now = Date.UTC(2026, 9, 18, 12);
  const file = entry("a.txt", { size: 1536, mtime: now - 3 * 3_600_000 });
  assert.equal(entryMeta(file, "name", now), null);
  assert.equal(entryMeta(file, "modified", now), "3h");
  assert.equal(entryMeta(file, "size", now), "1.5 KB");
  assert.equal(entryMeta(entry("src", { dir: true, mtime: now }), "size", now), null, "folders have no size");
  assert.equal(entryMeta(entry("old"), "modified", now), null, "older servers send no mtime");
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(1024), "1 KB");
  assert.equal(formatSize(14 * 1024 + 300), "14 KB");
  assert.equal(formatSize(3.4 * 1024 * 1024), "3.4 MB");
});

test("quick-open highlighting marks a contiguous hit, else the ordered subsequence", () => {
  assert.deepEqual(matchSegments("AGENTS.md", "agents"), [{ text: "AGENTS", hit: true }, { text: ".md", hit: false }]);
  assert.deepEqual(matchSegments("EditorView.tsx", "evt").filter((part) => part.hit).map((part) => part.text), ["E", "V", "t"]);
  assert.deepEqual(matchSegments("index.ts", "zzz"), [{ text: "index.ts", hit: false }]);
  assert.deepEqual(splitPath("packages/files/src/index.ts"), { name: "index.ts", dir: "packages/files/src" });
  assert.deepEqual(splitPath("README.md"), { name: "README.md", dir: "" });
});

function fakeFile(name: string, size = 4): File {
  return { name, size, arrayBuffer: async () => new Uint8Array(size).buffer } as unknown as File;
}

test("uploads check every name first and replace existing files only after a yes", async () => {
  const existing = new Map<string, "file" | "dir">([["docs/a.txt", "file"], ["docs/sub", "dir"]]);
  const writes: string[] = [];
  const api = {
    filesStatOptional: async (_projectId: string, relPath: string) => {
      const kind = existing.get(relPath);
      return kind ? { path: relPath, kind, size: 1 } : null;
    },
    filesUpload: async (_projectId: string, relPath: string) => { writes.push(relPath); return { ok: true as const }; },
  };
  const reasons = { tooLarge: "too large", isFolder: "is folder", invalidName: "invalid" };
  const asked: string[][] = [];
  const base = { projectId: "p1", sessionId: null, repositoryId: "primary", dir: "docs", reasons };
  const files = [fakeFile("a.txt"), fakeFile("b.txt"), fakeFile("sub"), fakeFile("huge.bin", MAX_UPLOAD_BYTES + 1), fakeFile("..")];

  const kept = await uploadIntoFolder({ ...base, files, confirmReplace: async (names) => { asked.push([...names]); return false; } }, api as never);
  assert.deepEqual(asked, [["a.txt"]], "one question lists every existing name");
  assert.deepEqual(writes, ["docs/b.txt"]);
  assert.deepEqual(kept.uploaded, ["docs/b.txt"]);
  assert.deepEqual(kept.skipped, ["a.txt"]);
  assert.deepEqual(kept.failed.map((item) => [item.name, item.reason]).sort(), [["..", "invalid"], ["huge.bin", "too large"], ["sub", "is folder"]]);

  writes.length = 0;
  const progress: string[] = [];
  const replaced = await uploadIntoFolder({
    ...base,
    files: [fakeFile("a.txt")],
    confirmReplace: async () => true,
    onProgress: (done, total) => progress.push(`${done}/${total}`),
  }, api as never);
  assert.deepEqual(replaced.uploaded, ["docs/a.txt"]);
  assert.deepEqual(progress, ["0/1", "1/1"]);
  assert.equal(joinPath("", "x"), "x");
  assert.equal(validUploadName("a/b"), false);
});

test("tree entries carry mtime and /api/files/raw honours an explicit download", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "polyth-file-manager-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "notes.txt"), "hello");
    const stamp = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    await utimes(path.join(root, "notes.txt"), stamp, stamp);
    const listed = await createFileService().tree(root);
    assert.equal(listed.find((item) => item.name === "notes.txt")?.mtime, stamp.getTime());
    assert.equal(typeof listed.find((item) => item.name === "src")?.mtime, "number", "folders carry mtime too");

    const projects = { get: async (id: string) => id === "p1" ? { id, path: root, name: "repo" } : undefined } as unknown as ProjectService;
    const route = workspaceRoutes({ projects, sessions: {} as SessionService, files: createFileService() });
    const fetchRaw = async (query: string) => {
      let headers: Record<string, string> = {};
      let body: Buffer | undefined;
      await route({
        path: "/api/files/raw",
        method: "GET",
        url: new URL(`https://polyth.test/api/files/raw?projectId=p1&path=notes.txt${query}`),
        req: { headers: {} },
        res: {
          writeHead: (_status: number, next: Record<string, string>) => { headers = next; },
          end: (data?: Buffer) => { body = data; },
        },
      } as unknown as RouteRequest);
      return { disposition: headers["content-disposition"], body: body?.toString("utf8") };
    };
    assert.match((await fetchRaw("")).disposition ?? "", /^inline;/);
    const download = await fetchRaw("&download=1");
    assert.match(download.disposition ?? "", /^attachment; filename\*=UTF-8''notes\.txt$/);
    assert.equal(download.body, "hello");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Entries of a ZIP, read back through its central directory. */
function readZip(zip: Buffer): Array<{ name: string; data: Buffer; method: number }> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "has an end-of-central-directory record");
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  const out: Array<{ name: string; data: Buffer; method: number }> = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressed = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const local = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const body = zip.subarray(start, start + compressed);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    assert.equal(crc32(data), crc, `${name} checksum`);
    out.push({ name, data, method });
    cursor += 46 + nameLength;
  }
  return out;
}

async function routeCall(route: ReturnType<typeof workspaceRoutes>, url: string) {
  let status = 0;
  let json: unknown;
  let headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  await route({
    path: new URL(url, "https://polyth.test").pathname,
    method: "GET",
    url: new URL(url, "https://polyth.test"),
    req: { headers: {} },
    json: (code: number, body: unknown) => { status = code; json = body; },
    res: {
      destroyed: false,
      writeHead: (code: number, next: Record<string, string>) => { status = code; headers = next; },
      write: (chunk: Buffer) => { chunks.push(Buffer.from(chunk)); return true; },
      once: () => {},
      end: (data?: Buffer) => { if (data) chunks.push(Buffer.from(data)); },
      destroy: () => { throw new Error("archive stream was cut"); },
    },
  } as unknown as RouteRequest);
  return { status, json, headers, body: Buffer.concat(chunks) };
}

test("list walks every file once; archives stream a valid zip of what the tree shows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "polyth-file-archive-"));
  try {
    await mkdir(path.join(root, "src/deep"), { recursive: true });
    await mkdir(path.join(root, "node_modules/pkg"), { recursive: true });
    await writeFile(path.join(root, "src/app.ts"), "export const answer = 42;\n".repeat(64));
    await writeFile(path.join(root, "src/deep/привіт.txt"), "вітаю");
    await writeFile(path.join(root, "src/.env"), "HIDDEN=1");
    await writeFile(path.join(root, "src/logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    await writeFile(path.join(root, "node_modules/pkg/index.js"), "x");
    await writeFile(path.join(root, "outside.txt"), "not linked");
    await symlink(path.join(root, "outside.txt"), path.join(root, "src/link.txt"));

    const files = createFileService();
    const listed = await files.list(root);
    assert.deepEqual(listed.entries.map((item) => item.path), ["outside.txt", "src/app.ts", "src/deep/привіт.txt", "src/logo.png"],
      "heavy folders, dot-files and symlinks stay out");
    assert.equal(listed.truncated, false);
    assert.ok(listed.entries.every((item) => !item.dir && typeof item.size === "number" && typeof item.mtime === "number"));
    assert.deepEqual((await files.list(root, { path: "src", hidden: true })).entries.map((item) => item.path),
      ["src/.env", "src/app.ts", "src/deep/привіт.txt", "src/logo.png"]);
    const capped = await files.list(root, { limit: 2 });
    assert.equal(capped.entries.length, 2);
    assert.equal(capped.truncated, true);
    await assert.rejects(files.list(root, { path: "../" }), /escapes|outside/i);

    const projects = { get: async (id: string) => id === "p1" ? { id, path: root, name: "repo" } : undefined } as unknown as ProjectService;
    const route = workspaceRoutes({ projects, sessions: {} as SessionService, files });
    const flat = await routeCall(route, "/api/files/list?projectId=p1&path=src");
    assert.equal(flat.status, 200);
    assert.equal((flat.json as { entries: FileEntry[] }).entries.length, 3);

    const check = await routeCall(route, "/api/files/archive?projectId=p1&path=src&check=1");
    assert.deepEqual({ ...(check.json as object), bytes: undefined }, { name: "src", files: 3, bytes: undefined, refusal: null });
    const zip = await routeCall(route, "/api/files/archive?projectId=p1&path=src");
    assert.equal(zip.headers["content-type"], "application/zip");
    assert.match(zip.headers["content-disposition"] ?? "", /^attachment; filename\*=UTF-8''src\.zip$/);
    const entries = readZip(zip.body);
    assert.deepEqual(entries.map((item) => item.name), ["src/app.ts", "src/deep/привіт.txt", "src/logo.png"]);
    assert.equal(entries[0]!.method, 8, "text is deflated");
    assert.equal(entries[0]!.data.toString("utf8"), "export const answer = 42;\n".repeat(64));
    assert.equal(entries[1]!.data.toString("utf8"), "вітаю", "UTF-8 names and bytes survive");
    assert.equal(entries[2]!.method, 0, "already-compressed formats are stored");

    const withHidden = readZip((await routeCall(route, "/api/files/archive?projectId=p1&path=src&hidden=true")).body);
    assert.ok(withHidden.some((item) => item.name === "src/.env"), "hidden files follow the tree's Show hidden");
    const empty = await routeCall(route, "/api/files/archive?projectId=p1&path=src/deep&check=1");
    assert.equal((empty.json as { refusal: unknown }).refusal, null);
    await mkdir(path.join(root, "void"));
    const refused = await routeCall(route, "/api/files/archive?projectId=p1&path=void");
    assert.equal(refused.status, 404);
    assert.deepEqual((refused.json as { refusal: unknown }).refusal, { reason: "empty" });
    const ignoredPlan = await planArchive({
      ...files,
      list: async () => ({ entries: [{ name: "a", path: "a", dir: false, size: 1, ignored: true }, { name: "b", path: "b", dir: false, size: 2 }], truncated: false }),
    }, root, "", { skipIgnored: true });
    assert.deepEqual(ignoredPlan.files.map((item) => item.path), ["b"], "ignored files stay out when the tree hides them");
    assert.equal(ignoredPlan.name, path.basename(root));
    // Both routes resolve roots like every files route: a project the scoped
    // project service does not know is refused, never read.
    for (const url of ["/api/files/list?projectId=p-foreign", "/api/files/archive?projectId=p-foreign&check=1", "/api/files/archive?projectId=p-foreign"]) {
      await assert.rejects(routeCall(route, url), (error: { code?: string }) => error.code === "not-found", url);
    }
    await assert.rejects(routeCall(route, "/api/files/archive?projectId=p1&path=../&check=1"), /escapes|outside/i);
    const tooMany = await planArchive({ ...files, list: async () => ({ entries: [], truncated: true }) }, root, "");
    assert.equal(tooMany.refusal?.reason, "too-many");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CSV parsing follows RFC 4180 quoting and guesses the separator", () => {
  const table = parseCsv('\ufeffname,age,"note, quoted"\r\n"Bob ""B""",42,"two\nlines"\nAnn,7,\n\n', "people.csv");
  assert.equal(table.delimiter, ",");
  assert.deepEqual(table.header, ["name", "age", "note, quoted"]);
  assert.deepEqual(table.rows, [['Bob "B"', "42", "two\nlines"], ["Ann", "7", ""]]);
  assert.equal(table.columns, 3);
  assert.deepEqual(numericColumns(table), [false, true, false]);
  assert.deepEqual(sortRows(table.rows, 1, 1, true).map((row) => row[0]), ["Ann", 'Bob "B"'], "7 before 42 numerically");
  assert.equal(guessDelimiter("a;b;c\n1;2;3", "x.csv"), ";");
  assert.equal(guessDelimiter("a,b", "x.tsv"), "\t");
  assert.equal(numericValue("1,234.5"), 1234.5);
  assert.equal(numericValue("12%"), 12);
  assert.equal(numericValue("$61,876"), 61876);
  assert.equal(numericValue("-€3.5"), -3.5);
  assert.equal(numericValue("v1"), null);
  const capped = parseCsv(`h\n${Array.from({ length: 20 }, (_, index) => index).join("\n")}`, "x.csv", 5);
  assert.equal(capped.rows.length, 5);
  assert.equal(capped.truncated, true);
  assert.equal(previewKindForPath("data/people.CSV"), "csv");
  assert.equal(previewKindForPath("icons/logo.svg"), "svg");
});

test("the outline lists the declarations a reader navigates by", () => {
  const ts = [
    "export interface Props {",
    "}",
    "/* function hidden() {} */",
    "export default function View() {",
    "  const onClick = async (event) => {",
    "  };",
    "  if (ready) {",
    "  }",
    "}",
    "export class Store {",
    "  constructor() {",
    "  }",
    "  async load() {",
    "  }",
    "}",
    "type Mode = 'a' | 'b';",
  ].join("\n");
  assert.deepEqual(extractSymbols(ts, "view.tsx").map((symbol) => `${symbol.depth}:${symbol.kind}:${symbol.name}@${symbol.line}`), [
    "0:interface:Props@1", "0:function:View@4", "1:function:onClick@5", "0:class:Store@10",
    "1:method:constructor@11", "1:method:load@13", "0:type:Mode@16",
  ]);
  const md = "# Title\n\n```sh\n# not a heading\n```\n## Part\nSub\n---\n";
  assert.deepEqual(extractSymbols(md, "README.md").map((symbol) => `${symbol.depth}:${symbol.name}`), ["0:Title", "1:Part", "1:Sub"]);
  assert.deepEqual(extractSymbols("class A:\n    def run(self):\n        pass\n# def no():\n", "a.py").map((symbol) => `${symbol.kind}:${symbol.name}`), ["class:A", "method:run"]);
  assert.deepEqual(extractSymbols("impl Tree {\n    pub fn new() -> Self {}\n}\n", "a.rs").map((symbol) => symbol.name), ["Tree", "new"]);
  assert.deepEqual(extractSymbols(".a, .b {\n  color: red;\n  &:hover {\n  }\n}\n", "a.scss").map((symbol) => `${symbol.depth}:${symbol.name}`), ["0:.a, .b", "1:&:hover"]);
  assert.equal(hasOutline("notes.txt"), false);
  assert.deepEqual(filterSymbols(extractSymbols(ts, "view.tsx"), "ld").map((symbol) => symbol.name), ["load"], "subsequence filter");
  assert.deepEqual(filterSymbols(extractSymbols(ts, "view.tsx"), "o").map((symbol) => symbol.name).slice(0, 2), ["onClick", "Props"], "prefix hits first");
});

test("a dragged row moves only into another folder that is not inside it", () => {
  assert.equal(canMoveInto({ path: "src/a.ts", dir: false }, "docs"), true);
  assert.equal(canMoveInto({ path: "src/a.ts", dir: false }, "src"), false, "already there");
  assert.equal(canMoveInto({ path: "src/a.ts", dir: false }, ""), true, "to the root");
  assert.equal(canMoveInto({ path: "src", dir: true }, "src"), false, "onto itself");
  assert.equal(canMoveInto({ path: "src", dir: true }, "src/deep"), false, "into its own subtree");
  assert.equal(canMoveInto({ path: "src", dir: true }, "srcs"), true, "a sibling sharing a prefix is fine");
  const flat = [entry("b/z.ts", { size: 1, mtime: 5 }), entry("a.ts", { size: 9, mtime: 1 }), entry("b/a.ts", { size: 9, mtime: 9 })];
  assert.deepEqual(sortFlat(flat, "name").map((item) => item.path), ["a.ts", "b/a.ts", "b/z.ts"]);
  assert.deepEqual(sortFlat(flat, "modified").map((item) => item.path), ["b/a.ts", "b/z.ts", "a.ts"]);
  assert.deepEqual(sortFlat(flat, "size").map((item) => item.path), ["a.ts", "b/a.ts", "b/z.ts"]);
});
