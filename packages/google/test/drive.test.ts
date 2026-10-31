import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleClient, GoogleError } from "../src/http.ts";
import { createDriveService, defaultFilenameFor, DRIVE_FOLDER_MIME } from "../src/drive.ts";
import type { DriveFile } from "../src/drive.ts";

interface Call { method: string; url: URL; headers: Headers; body: Uint8Array | undefined }
type Handler = (call: Call) => Response | Promise<Response>;

function setup(handler: Handler) {
  const calls: Call[] = [];
  const client = createGoogleClient({
    tokens: { accessToken: async () => "test-token" },
    sleep: async () => {},
    fetch: async (input, init) => {
      let body: Uint8Array | undefined;
      if (init.body instanceof Blob) body = new Uint8Array(await init.body.arrayBuffer());
      else if (typeof init.body === "string") body = new TextEncoder().encode(init.body);
      const call = { method: init.method ?? "GET", url: new URL(input), headers: new Headers(init.headers), body };
      calls.push(call);
      return handler(call);
    },
  });
  return { drive: createDriveService(client), calls };
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const bodyJson = (call: Call): any => JSON.parse(new TextDecoder().decode(call.body));
const apiError = (status: number, reason: string, message = reason): Response =>
  json({ error: { code: status, message, errors: [{ reason }] } }, status);
const gdoc = (id: string, mimeType: string, extra: Record<string, unknown> = {}) => ({ id, name: `n-${id}`, mimeType, ...extra });

test("search builds an escaped q, defaults trashed filter and explicit fields", async () => {
  const { drive, calls } = setup(() => json({ files: [], incompleteSearch: false }));
  await drive.search({ name: "O'Brien\\notes", text: "a 'b'", mimeType: "application/pdf", folderId: "root", starred: true, sharedWithMe: true, modifiedAfter: "2026-01-01T00:00:00Z", query: "name = 'x' or name = 'y'" });
  const url = calls[0]!.url;
  assert.equal(url.origin + url.pathname, "https://www.googleapis.com/drive/v3/files");
  assert.equal(
    url.searchParams.get("q"),
    "fullText contains 'a \\'b\\'' and name contains 'O\\'Brien\\\\notes' and mimeType = 'application/pdf' and 'root' in parents"
    + " and sharedWithMe = true and starred = true and modifiedTime > '2026-01-01T00:00:00Z' and trashed = false and (name = 'x' or name = 'y')",
  );
  assert.equal(url.searchParams.get("supportsAllDrives"), "true");
  assert.equal(url.searchParams.get("includeItemsFromAllDrives"), "true");
  assert.equal(url.searchParams.get("corpora"), "allDrives");
  assert.equal(url.searchParams.get("pageSize"), "50");
  assert.match(url.searchParams.get("fields")!, /^nextPageToken,incompleteSearch,files\(id,name,mimeType,size/);
});

test("search includeTrashed drops the filter; driveId uses corpora=drive; pagination passes through", async () => {
  const { drive, calls } = setup(() => json({ files: [gdoc("a", "text/plain")], nextPageToken: "NEXT", incompleteSearch: true }));
  const result = await drive.search({ includeTrashed: true, driveId: "drv_1", pageSize: 9999, pageToken: "TOK", orderBy: "modifiedTime desc,name" });
  const q = calls[0]!.url.searchParams;
  assert.equal(q.get("q"), "");
  assert.equal(q.get("corpora"), "drive");
  assert.equal(q.get("driveId"), "drv_1");
  assert.equal(q.get("pageSize"), "200");
  assert.equal(q.get("pageToken"), "TOK");
  assert.equal(q.get("orderBy"), "modifiedTime desc,name");
  assert.equal(result.nextPageToken, "NEXT");
  assert.equal(result.incompleteSearch, true);
  assert.equal(result.files.length, 1);
});

test("search validates ids, orderBy, pageSize floor and modifiedAfter", async () => {
  const { drive, calls } = setup(() => json({ files: [] }));
  await assert.rejects(drive.search({ folderId: "a' or '1'='1" }), { code: "invalid-request" });
  await assert.rejects(drive.search({ orderBy: "bogus" }), { code: "invalid-request" });
  await assert.rejects(drive.search({ modifiedAfter: "yesterday" }), { code: "invalid-request" });
  await drive.search({ pageSize: 0 });
  assert.equal(calls[0]!.url.searchParams.get("pageSize"), "1");
});

test("list queries a folder ordered folder,name_natural", async () => {
  const { drive, calls } = setup(() => json({ files: [] }));
  await drive.list({});
  const q = calls[0]!.url.searchParams;
  assert.equal(q.get("q"), "'root' in parents and trashed = false");
  assert.equal(q.get("orderBy"), "folder,name_natural");
  assert.equal(q.get("includeItemsFromAllDrives"), "true");
  await drive.list({ folderId: "F1", includeTrashed: true });
  assert.equal(calls[1]!.url.searchParams.get("q"), "'F1' in parents");
});

test("get normalizes size, kinds, shortcut target, capabilities and export aliases", async () => {
  const { drive, calls } = setup((call) => {
    const id = call.url.pathname.split("/").pop()!;
    if (id === "bin") return json({ id, name: "a.bin", mimeType: "application/octet-stream", size: "1234", owners: [{ displayName: "Me", emailAddress: "me@x.com" }], capabilities: { canEdit: true, canDownload: false, canShare: true }, parents: ["p"], driveId: "D", trashed: false });
    if (id === "doc") return json(gdoc(id, "application/vnd.google-apps.document", { starred: true, shared: true }));
    if (id === "sc") return json(gdoc(id, "application/vnd.google-apps.shortcut", { shortcutDetails: { targetId: "T", targetMimeType: "text/plain" } }));
    if (id === "frm") return json(gdoc(id, "application/vnd.google-apps.form"));
    if (id === "vid") return json(gdoc(id, "application/vnd.google-apps.vid"));
    return json(gdoc(id, DRIVE_FOLDER_MIME));
  });
  const bin = await drive.get("bin");
  assert.equal(bin.size, 1234);
  assert.equal(bin.kind, "file");
  assert.deepEqual(bin.owners, [{ name: "Me", email: "me@x.com" }]);
  assert.equal(bin.canEdit, true);
  assert.equal(bin.canDownload, false);
  assert.equal(bin.canTrash, undefined);
  assert.equal(bin.driveId, "D");
  assert.equal(bin.exportFormats, undefined);
  const doc = await drive.get("doc");
  assert.equal(doc.kind, "document");
  assert.equal(doc.starred, true);
  assert.ok(doc.exportFormats!.includes("markdown"));
  assert.equal(doc.size, undefined);
  const sc = await drive.get("sc");
  assert.equal(sc.kind, "shortcut");
  assert.equal(sc.shortcutTargetId, "T");
  assert.equal(sc.shortcutTargetMimeType, "text/plain");
  assert.equal((await drive.get("frm")).kind, "form");
  assert.equal((await drive.get("vid")).kind, "google-other");
  assert.equal((await drive.get("fld")).kind, "folder");
  assert.equal(calls[0]!.url.searchParams.get("supportsAllDrives"), "true");
  assert.match(calls[0]!.url.searchParams.get("fields")!, /shortcutDetails\(targetId,targetMimeType\)/);
});

function readSetup(files: Record<string, unknown>, onContent?: Handler) {
  return setup((call) => {
    const parts = call.url.pathname.split("/");
    const isExport = parts.at(-1) === "export";
    const id = isExport ? parts.at(-2)! : parts.at(-1)!;
    if (isExport || call.url.searchParams.get("alt") === "media") {
      return onContent ? onContent(call) : new Response(`content:${id}:${call.url.searchParams.get("mimeType") ?? "media"}`);
    }
    return json(files[id] ?? { error: "none" });
  });
}

test("readContent exports default formats for doc, sheet and slides", async () => {
  const { drive, calls } = readSetup({
    d: gdoc("d", "application/vnd.google-apps.document"),
    s: gdoc("s", "application/vnd.google-apps.spreadsheet"),
    p: gdoc("p", "application/vnd.google-apps.presentation"),
    w: gdoc("w", "application/vnd.google-apps.drawing"),
  });
  const doc = await drive.readContent({ fileId: "d" });
  assert.equal(doc.mimeType, "text/markdown");
  assert.equal(doc.format, "markdown");
  assert.equal(doc.exported, true);
  assert.equal(new TextDecoder().decode(doc.data), "content:d:text/markdown");
  assert.equal((await drive.readContent({ fileId: "s" })).mimeType, "text/csv");
  assert.equal((await drive.readContent({ fileId: "p" })).mimeType, "text/plain");
  assert.equal((await drive.readContent({ fileId: "w" })).mimeType, "image/png");
  const exportCall = calls.find((call) => call.url.pathname === "/drive/v3/files/d/export")!;
  assert.equal(exportCall.url.searchParams.get("mimeType"), "text/markdown");
  assert.equal(exportCall.url.searchParams.get("supportsAllDrives"), "true");
});

test("readContent honors aliases and full mime types, and rejects unsupported formats", async () => {
  const { drive } = readSetup({ d: gdoc("d", "application/vnd.google-apps.document"), s: gdoc("s", "application/vnd.google-apps.spreadsheet") });
  assert.equal((await drive.readContent({ fileId: "d", format: "docx" })).mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal((await drive.readContent({ fileId: "d", format: "TXT" })).mimeType, "text/plain");
  const viaMime = await drive.readContent({ fileId: "s", format: "application/pdf" });
  assert.equal(viaMime.format, "pdf");
  await assert.rejects(drive.readContent({ fileId: "s", format: "docx" }), (error: unknown) => {
    assert.ok(error instanceof GoogleError);
    assert.equal(error.code, "invalid-request");
    assert.match(error.message, /csv, tsv, pdf, xlsx, ods/);
    return true;
  });
});

test("readContent downloads binary files with alt=media and rejects a format", async () => {
  const { drive, calls } = readSetup({ b: { id: "b", name: "pic.png", mimeType: "image/png", size: "10" } });
  const result = await drive.readContent({ fileId: "b", maxBytes: 100 });
  assert.equal(result.exported, false);
  assert.equal(result.mimeType, "image/png");
  assert.equal(result.format, undefined);
  const media = calls.at(-1)!;
  assert.equal(media.url.pathname, "/drive/v3/files/b");
  assert.equal(media.url.searchParams.get("alt"), "media");
  assert.equal(media.url.searchParams.get("acknowledgeAbuse"), null);
  await assert.rejects(drive.readContent({ fileId: "b", format: "pdf" }), { code: "invalid-request" });
});

test("readContent refuses oversized binaries and non-downloadable Google types", async () => {
  const { drive } = readSetup({
    big: { id: "big", name: "big.bin", mimeType: "application/zip", size: "5000" },
    f: gdoc("f", DRIVE_FOLDER_MIME),
    frm: gdoc("frm", "application/vnd.google-apps.form"),
  });
  await assert.rejects(drive.readContent({ fileId: "big", maxBytes: 1000 }), { code: "too-large" });
  await assert.rejects(drive.readContent({ fileId: "f" }), { code: "invalid-request", message: /cannot be downloaded/ });
  await assert.rejects(drive.readContent({ fileId: "frm" }), { code: "invalid-request", message: /cannot be downloaded/ });
});

test("readContent follows a shortcut exactly once", async () => {
  const { drive } = readSetup({
    sc: gdoc("sc", "application/vnd.google-apps.shortcut", { shortcutDetails: { targetId: "T" } }),
    T: { id: "T", name: "t.txt", mimeType: "text/plain", size: "3" },
    sc2: gdoc("sc2", "application/vnd.google-apps.shortcut", { shortcutDetails: { targetId: "sc" } }),
  });
  const result = await drive.readContent({ fileId: "sc" });
  assert.equal(result.file.id, "T");
  assert.equal(new TextDecoder().decode(result.data), "content:T:media");
  await assert.rejects(drive.readContent({ fileId: "sc2" }), { code: "invalid-request", message: /another shortcut/ });
});

test("readContent maps Google download reasons", async () => {
  const files = { d: gdoc("d", "application/vnd.google-apps.document"), b: { id: "b", name: "b.bin", mimeType: "application/zip" } };
  const limited = readSetup(files, () => apiError(403, "exportSizeLimitExceeded"));
  await assert.rejects(limited.drive.readContent({ fileId: "d" }), (error: unknown) => {
    assert.ok(error instanceof GoogleError);
    assert.equal(error.code, "too-large");
    assert.match(error.message, /10 MB/);
    return true;
  });
  const blocked = readSetup(files, () => apiError(403, "fileNotDownloadable"));
  await assert.rejects(blocked.drive.readContent({ fileId: "b" }), { code: "permission-denied", message: /cannot be downloaded/ });
  const abusive = readSetup(files, () => apiError(403, "cannotDownloadAbusiveFile"));
  await assert.rejects(abusive.drive.readContent({ fileId: "b" }), { code: "permission-denied", message: /malware or abuse/ });
  assert.ok(!abusive.calls.some((call) => call.url.searchParams.has("acknowledgeAbuse")));
});

test("defaultFilenameFor appends export extensions and sanitizes names", () => {
  const base = { id: "1", mimeType: "", trashed: false, starred: false, shared: false };
  const doc: DriveFile = { ...base, name: "Report", kind: "document" };
  const sheet: DriveFile = { ...base, name: "Budget", kind: "spreadsheet" };
  const bin: DriveFile = { ...base, name: "a/b\\c\u0001.png", kind: "file" };
  assert.equal(defaultFilenameFor(doc, "text/markdown"), "Report.md");
  assert.equal(defaultFilenameFor(sheet, "text/csv"), "Budget.csv");
  assert.equal(defaultFilenameFor({ ...doc, name: "Report.md" }, "text/markdown"), "Report.md");
  assert.equal(defaultFilenameFor(bin, "image/png"), "a_b_c_.png");
  assert.equal(defaultFilenameFor({ ...bin, name: ".." }, "image/png"), "download");
});

function splitMultipart(call: Call) {
  const contentType = call.headers.get("content-type")!;
  const boundary = /boundary=(.+)$/.exec(contentType)![1]!;
  const text = Buffer.from(call.body!).toString("latin1");
  const parts = text.split(`--${boundary}`);
  assert.equal(parts[0], "");
  assert.equal(parts.at(-1), "--");
  return parts.slice(1, -1).map((part) => {
    const [head, ...rest] = part.replace(/^\r\n/, "").split("\r\n\r\n");
    return { head: head!, body: rest.join("\r\n\r\n").replace(/\r\n$/, "") };
  });
}

test("upload sends multipart/related with JSON metadata then content", async () => {
  const { drive, calls } = setup(() => json({ id: "new", name: "a.txt", mimeType: "text/plain" }));
  const result = await drive.upload({ name: "a.txt", data: new TextEncoder().encode("hello"), mimeType: "text/plain", parentId: "PAR", description: "d" });
  assert.equal(result.id, "new");
  const call = calls[0]!;
  assert.equal(call.method, "POST");
  assert.equal(call.url.pathname, "/upload/drive/v3/files");
  assert.equal(call.url.searchParams.get("uploadType"), "multipart");
  assert.equal(call.url.searchParams.get("supportsAllDrives"), "true");
  assert.ok(call.url.searchParams.get("fields"));
  assert.match(call.headers.get("content-type")!, /^multipart\/related; boundary=/);
  const [meta, content] = splitMultipart(call);
  assert.match(meta!.head, /Content-Type: application\/json/);
  assert.deepEqual(JSON.parse(meta!.body), { name: "a.txt", description: "d", mimeType: "text/plain", parents: ["PAR"] });
  assert.match(content!.head, /Content-Type: text\/plain/);
  assert.equal(content!.body, "hello");
});

test("upload convertTo sets the Workspace target mimeType and keeps the source content type", async () => {
  const { drive, calls } = setup(() => json({ id: "n", name: "Sheet", mimeType: "application/vnd.google-apps.spreadsheet" }));
  await drive.upload({ name: "Sheet", data: new TextEncoder().encode("a,b\n1,2"), mimeType: "text/csv", convertTo: "spreadsheet" });
  const [meta, content] = splitMultipart(calls[0]!);
  assert.equal(JSON.parse(meta!.body).mimeType, "application/vnd.google-apps.spreadsheet");
  assert.match(content!.head, /Content-Type: text\/csv/);
});

test("upload with fileId replaces content via PATCH without placement metadata", async () => {
  const { drive, calls } = setup(() => json({ id: "F", name: "x", mimeType: "text/plain" }));
  await drive.upload({ fileId: "F", name: "ignored-parent", data: new Uint8Array([1, 2, 3]), mimeType: "application/octet-stream", parentId: "P" } as any);
  const call = calls[0]!;
  assert.equal(call.method, "PATCH");
  assert.equal(call.url.pathname, "/upload/drive/v3/files/F");
  const meta = JSON.parse(splitMultipart(call)[0]!.body);
  assert.equal(meta.parents, undefined);
  assert.equal(meta.mimeType, undefined);
  await drive.upload({ fileId: "F", data: new Uint8Array([1]), mimeType: "text/plain" });
});

test("upload validates names, size and mime type", async () => {
  const { drive, calls } = setup(() => json({}));
  const data = new Uint8Array(1);
  await assert.rejects(drive.upload({ name: "", data, mimeType: "text/plain" }), { code: "invalid-request" });
  await assert.rejects(drive.upload({ name: "a\nb", data, mimeType: "text/plain" }), { code: "invalid-request" });
  await assert.rejects(drive.upload({ name: "x".repeat(256), data, mimeType: "text/plain" }), { code: "invalid-request" });
  await assert.rejects(drive.upload({ name: "a", data, mimeType: "not a mime" }), { code: "invalid-request" });
  await assert.rejects(drive.upload({ name: "a", data: new Uint8Array(100 * 1024 * 1024 + 1), mimeType: "text/plain" }), { code: "too-large" });
  assert.equal(calls.length, 0);
});

test("upload above 5 MiB uses a resumable session: POST then one PUT to Location", async () => {
  const data = new Uint8Array(5 * 1024 * 1024 + 1).fill(7);
  const session = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc";
  const { drive, calls } = setup((call) => call.method === "POST"
    ? new Response(null, { status: 200, headers: { location: session } })
    : json({ id: "big", name: "big.bin", mimeType: "application/zip", size: String(data.byteLength) }, 200));
  const result = await drive.upload({ name: "big.bin", data, mimeType: "application/zip", parentId: "P" });
  assert.equal(result.size, data.byteLength);
  assert.equal(calls.length, 2);
  const [start, put] = calls as [Call, Call];
  assert.equal(start.method, "POST");
  assert.equal(start.url.searchParams.get("uploadType"), "resumable");
  assert.equal(start.headers.get("x-upload-content-type"), "application/zip");
  assert.equal(start.headers.get("x-upload-content-length"), String(data.byteLength));
  assert.deepEqual(bodyJson(start), { name: "big.bin", mimeType: "application/zip", parents: ["P"] });
  assert.equal(put.method, "PUT");
  assert.equal(put.url.toString(), session);
  assert.equal(put.body!.byteLength, data.byteLength);
  assert.equal(put.headers.get("content-type"), "application/zip");
});

test("resumable upload rejects a Location outside www.googleapis.com", async () => {
  const data = new Uint8Array(5 * 1024 * 1024 + 1);
  const { drive, calls } = setup(() => new Response(null, { status: 200, headers: { location: "https://evil.example/upload" } }));
  await assert.rejects(drive.upload({ name: "big", data, mimeType: "application/zip" }), { code: "invalid-state" });
  assert.equal(calls.length, 1);
});

test("createFolder posts the folder mime type and parent", async () => {
  const { drive, calls } = setup(() => json({ id: "F", name: "Docs", mimeType: DRIVE_FOLDER_MIME }));
  const folder = await drive.createFolder({ name: "Docs", parentId: "P" });
  assert.equal(folder.kind, "folder");
  assert.deepEqual(bodyJson(calls[0]!), { name: "Docs", mimeType: DRIVE_FOLDER_MIME, parents: ["P"] });
  assert.equal(calls[0]!.url.searchParams.get("supportsAllDrives"), "true");
});

test("move reads current parents then adds the target and removes the old ones", async () => {
  const { drive, calls } = setup((call) => call.method === "GET"
    ? json({ id: "X", name: "x", mimeType: "text/plain", parents: ["OLD1", "OLD2"] })
    : json({ id: "X", name: "x", mimeType: "text/plain", parents: ["NEW"] }));
  const moved = await drive.move({ fileId: "X", folderId: "NEW" });
  assert.deepEqual(moved.parents, ["NEW"]);
  const patch = calls[1]!;
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.url.searchParams.get("addParents"), "NEW");
  assert.equal(patch.url.searchParams.get("removeParents"), "OLD1,OLD2");
  assert.equal(patch.url.searchParams.get("supportsAllDrives"), "true");
});

test("copy rejects folders and otherwise posts name and parent", async () => {
  const { drive, calls } = setup((call) => {
    if (call.method === "GET") return json(call.url.pathname.endsWith("/FLD") ? gdoc("FLD", DRIVE_FOLDER_MIME) : gdoc("OK", "text/plain"));
    return json(gdoc("COPY", "text/plain"));
  });
  await assert.rejects(drive.copy({ fileId: "FLD" }), { code: "invalid-request", message: /cannot copy folders/ });
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  const copied = await drive.copy({ fileId: "OK", name: "Copy", parentId: "P" });
  assert.equal(copied.id, "COPY");
  const post = calls.at(-1)!;
  assert.equal(post.url.pathname, "/drive/v3/files/OK/copy");
  assert.deepEqual(bodyJson(post), { name: "Copy", parents: ["P"] });
});

test("rename and trash use PATCH; restore untrashes; deletePermanently uses DELETE", async () => {
  const { drive, calls } = setup((call) => call.method === "DELETE" ? new Response(null, { status: 204 }) : json(gdoc("X", "text/plain")));
  await drive.rename({ fileId: "X", name: "New" });
  assert.deepEqual(bodyJson(calls[0]!), { name: "New" });
  await drive.trash({ fileId: "X" });
  assert.deepEqual(bodyJson(calls[1]!), { trashed: true });
  await drive.trash({ fileId: "X", restore: true });
  assert.deepEqual(bodyJson(calls[2]!), { trashed: false });
  assert.equal(calls[2]!.method, "PATCH");
  assert.deepEqual(await drive.deletePermanently("X"), { deleted: true });
  const del = calls[3]!;
  assert.equal(del.method, "DELETE");
  assert.equal(del.url.pathname, "/drive/v3/files/X");
  assert.equal(del.url.searchParams.get("supportsAllDrives"), "true");
  await assert.rejects(drive.rename({ fileId: "X", name: "bad\nname" }), { code: "invalid-request" });
});

test("listPermissions follows every page and skips deleted entries", async () => {
  const { drive, calls } = setup((call) => call.url.searchParams.get("pageToken")
    ? json({ permissions: [{ id: "p2", type: "anyone", role: "reader" }] })
    : json({ permissions: [{ id: "p1", type: "user", role: "writer", emailAddress: "a@b.co", displayName: "A", expirationTime: "2027-01-01T00:00:00Z" }, { id: "gone", type: "user", role: "reader", deleted: true }], nextPageToken: "T2" }));
  const permissions = await drive.listPermissions("F");
  assert.deepEqual(permissions, [
    { id: "p1", type: "user", role: "writer", emailAddress: "a@b.co", displayName: "A", expirationTime: "2027-01-01T00:00:00Z" },
    { id: "p2", type: "anyone", role: "reader" },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.url.searchParams.get("pageToken"), "T2");
  assert.equal(calls[0]!.url.searchParams.get("supportsAllDrives"), "true");
  assert.match(calls[0]!.url.searchParams.get("fields")!, /permissions\(id,type,role,emailAddress/);
});

test("share validates input and never transfers ownership", async () => {
  const { drive, calls } = setup((call) => json({ id: "perm", ...bodyJson(call) }));
  const user = await drive.share({ fileId: "F", role: "writer", type: "user", emailAddress: "a@b.co", emailMessage: "hi" });
  assert.deepEqual(user, { id: "perm", type: "user", role: "writer", emailAddress: "a@b.co" });
  let q = calls[0]!.url.searchParams;
  assert.equal(q.get("sendNotificationEmail"), "true");
  assert.equal(q.get("emailMessage"), "hi");
  assert.equal(q.get("transferOwnership"), null);
  assert.equal(q.get("supportsAllDrives"), "true");
  await drive.share({ fileId: "F", role: "reader", type: "domain", domain: "example.com", allowFileDiscovery: false });
  assert.deepEqual(bodyJson(calls[1]!), { role: "reader", type: "domain", domain: "example.com", allowFileDiscovery: false });
  q = calls[1]!.url.searchParams;
  assert.equal(q.get("sendNotificationEmail"), null);
  await drive.share({ fileId: "F", role: "reader", type: "anyone" });
  assert.deepEqual(bodyJson(calls[2]!), { role: "reader", type: "anyone" });
  await drive.share({ fileId: "F", role: "reader", type: "group", emailAddress: "g@b.co", sendNotificationEmail: false });
  assert.equal(calls[3]!.url.searchParams.get("sendNotificationEmail"), "false");
  const before = calls.length;
  await assert.rejects(drive.share({ fileId: "F", role: "owner" as any, type: "user", emailAddress: "a@b.co" }), { code: "invalid-request", message: /ownership/ });
  await assert.rejects(drive.share({ fileId: "F", role: "reader", type: "user" }), { code: "invalid-request" });
  await assert.rejects(drive.share({ fileId: "F", role: "reader", type: "user", emailAddress: "not-an-email" }), { code: "invalid-request" });
  await assert.rejects(drive.share({ fileId: "F", role: "reader", type: "domain" }), { code: "invalid-request" });
  await assert.rejects(drive.share({ fileId: "F", role: "reader", type: "anyone", emailMessage: "x" }), { code: "invalid-request" });
  await assert.rejects(drive.share({ fileId: "F", role: "reader", type: "user", emailAddress: "a@b.co", sendNotificationEmail: false, emailMessage: "x" }), { code: "invalid-request" });
  assert.equal(calls.length, before);
});

test("unshare deletes the permission", async () => {
  const { drive, calls } = setup(() => new Response(null, { status: 204 }));
  assert.deepEqual(await drive.unshare({ fileId: "F", permissionId: "perm123" }), { removed: true });
  assert.equal(calls[0]!.method, "DELETE");
  assert.equal(calls[0]!.url.pathname, "/drive/v3/files/F/permissions/perm123");
  assert.equal(calls[0]!.url.searchParams.get("supportsAllDrives"), "true");
  await assert.rejects(drive.unshare({ fileId: "F", permissionId: "../x" }), { code: "invalid-request" });
});

test("a 403 insufficientPermissions surfaces as insufficient-scope", async () => {
  const { drive } = setup(() => apiError(403, "insufficientPermissions", "Request had insufficient authentication scopes."));
  await assert.rejects(drive.get("F"), { code: "insufficient-scope" });
});
