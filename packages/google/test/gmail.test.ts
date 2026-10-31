import assert from "node:assert/strict";
import test from "node:test";
import { createGmailService } from "../src/gmail.ts";
import { GoogleError, createGoogleClient } from "../src/http.ts";
import { decodeBase64Url, decodeHeaderWords, encodeBase64Url, parseAddressList } from "../src/mime.ts";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me";

interface Call { method: string; url: URL; body: string }
type Handler = (call: Call) => { status?: number; json?: unknown } | undefined;

function setup(handler: Handler) {
  const calls: Call[] = [];
  const client = createGoogleClient({
    tokens: { accessToken: async () => "test-token" },
    sleep: async () => {},
    fetch: async (input, init) => {
      const body = init.body instanceof Blob ? await init.body.text() : typeof init.body === "string" ? init.body : "";
      const call = { method: init.method ?? "GET", url: new URL(input), body };
      calls.push(call);
      const result = handler(call);
      if (!result) return new Response(JSON.stringify({ error: { code: 500, message: `unexpected ${call.method} ${input}` } }), { status: 418 });
      return new Response(result.json === undefined ? null : JSON.stringify(result.json), { status: result.status ?? 200 });
    },
  });
  return { gmail: createGmailService(client), calls };
}

const path = (call: Call): string => call.url.origin + call.url.pathname;
const header = (name: string, value: string) => ({ name, value });
const b64 = (text: string | Uint8Array): string => encodeBase64Url(text);
const notFound = { status: 404, json: { error: { code: 404, message: "Requested entity was not found." } } };

function wireMessage(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, threadId: `t-${id}`, labelIds: ["INBOX", "UNREAD"], snippet: "It&#39;s here", internalDate: "1759708800000",
    payload: { mimeType: "text/plain", headers: [header("From", "\"Doe, John\" <john@example.com>"), header("To", "me@example.com"), header("Subject", "Hello"), header("Date", "x")] },
    ...extra,
  };
}

test("search fans out metadata reads, passes pagination through and skips ids that vanish", async () => {
  const { gmail, calls } = setup((call) => {
    if (path(call) === `${BASE}/messages`) return { json: { messages: [{ id: "a" }, { id: "gone" }, { id: "c" }], nextPageToken: "next-1", resultSizeEstimate: 42 } };
    const id = path(call).split("/").pop()!;
    if (id === "gone") return notFound;
    return { json: wireMessage(id) };
  });
  const result = await gmail.search({ query: "from:john", labelIds: ["INBOX", "UNREAD"], maxResults: 500, pageToken: "tok-0" });
  assert.deepEqual(result.messages.map((message) => message.id), ["a", "c"]);
  assert.equal(result.nextPageToken, "next-1");
  assert.equal(result.resultSizeEstimate, 42);
  const list = calls[0]!.url.searchParams;
  assert.equal(list.get("q"), "from:john");
  assert.equal(list.get("maxResults"), "100");
  assert.equal(list.get("pageToken"), "tok-0");
  assert.deepEqual(list.getAll("labelIds"), ["INBOX", "UNREAD"]);
  const get = calls.find((call) => path(call).endsWith("/messages/a"))!;
  assert.equal(get.url.searchParams.get("format"), "metadata");
  assert.deepEqual(get.url.searchParams.getAll("metadataHeaders"), ["From", "To", "Subject", "Date"]);
  const first = result.messages[0]!;
  assert.deepEqual(first.from, { name: "Doe, John", email: "john@example.com" });
  assert.equal(first.date, "2025-10-06T00:00:00.000Z");
  assert.equal(first.snippet, "It's here");
  assert.equal(first.unread, true);
});

test("search empty page and default page size", async () => {
  const { gmail, calls } = setup(() => ({ json: { resultSizeEstimate: 0 } }));
  assert.deepEqual(await gmail.search(), { messages: [], resultSizeEstimate: 0 });
  assert.equal(calls[0]!.url.searchParams.get("maxResults"), "20");
});

test("listThreads summarizes the latest message of each thread", async () => {
  const { gmail } = setup((call) => {
    if (path(call) === `${BASE}/threads`) return { json: { threads: [{ id: "t1", snippet: "snip" }], resultSizeEstimate: 1 } };
    return { json: { id: "t1", messages: [wireMessage("m1"), wireMessage("m2")] } };
  });
  const result = await gmail.listThreads({});
  assert.equal(result.threads[0]!.messageCount, 2);
  assert.equal(result.threads[0]!.latest.id, "m2");
  assert.equal(result.threads[0]!.snippet, "snip");
});

test("getMessage normalizes headers, body, attachments and fetches bodies delivered as attachmentId", async () => {
  const { gmail, calls } = setup((call) => {
    if (path(call).endsWith("/attachments/big-body")) return { json: { size: 5, data: b64("Large text body") } };
    return {
      json: wireMessage("m1", {
        payload: {
          partId: "", mimeType: "multipart/mixed",
          headers: [header("From", "=?UTF-8?B?0IbQstCw0L0=?= <ivan@ex.ua>"), header("To", "a@x.com, b@x.com"), header("Cc", "c@x.com"), header("Reply-To", "r@x.com"),
            header("Subject", "=?UTF-8?B?0J/RgNC40LLRltGC?="), header("Message-ID", "<orig@mail>")],
          parts: [
            { partId: "0", mimeType: "text/plain", filename: "", headers: [header("Content-Type", "text/plain; charset=UTF-8")], body: { attachmentId: "big-body", size: 99999 } },
            { partId: "1", mimeType: "application/pdf", filename: "doc.pdf", body: { attachmentId: "att-1", size: 1234 } },
          ],
        },
      }),
    };
  });
  const message = await gmail.getMessage("m1");
  assert.equal(message.subject, "Привіт");
  assert.deepEqual(message.from, { name: "Іван", email: "ivan@ex.ua" });
  assert.deepEqual(message.to.map((address) => address.email), ["a@x.com", "b@x.com"]);
  assert.deepEqual(message.cc, [{ email: "c@x.com" }]);
  assert.deepEqual(message.replyTo, [{ email: "r@x.com" }]);
  assert.equal(message.messageIdHeader, "<orig@mail>");
  assert.equal(message.body, "Large text body");
  assert.equal(message.bodyFormat, "text");
  assert.equal(message.bodyTruncated, false);
  assert.deepEqual(message.attachments, [{ partId: "1", filename: "doc.pdf", mimeType: "application/pdf", size: 1234, inline: false }]);
  assert.equal(message.hasAttachments, true);
  assert.ok(!JSON.stringify(message).includes("att-1"), "attachmentId must not leak");
  assert.equal(calls[0]!.url.searchParams.get("format"), "full");
  const truncated = await gmail.getMessage("m1", { maxBodyChars: 5 });
  assert.deepEqual([truncated.body, truncated.bodyTruncated], ["Large", true]);
});

const original = (extra: Record<string, unknown> = {}) => ({
  id: "orig", threadId: "thread-9",
  payload: { headers: [
    header("Message-ID", "<orig@mail>"), header("References", "<r0@mail>"), header("Subject", "Plan"),
    header("From", "Alice <alice@x.com>"), header("To", "me@example.com, Bob <bob@x.com>"), header("Cc", "Carol <carol@x.com>, ALICE@x.com"),
    ...(extra.headers as Array<{ name: string; value: string }> ?? []),
  ] },
});

function sentHandler(sent: { raw?: string; threadId?: string }) {
  return (call: Call) => {
    if (call.method === "GET" && path(call).endsWith("/messages/orig")) return { json: original() };
    if (call.method === "POST" && path(call) === `${BASE}/messages/send`) {
      const body = JSON.parse(call.body) as { raw: string; threadId?: string };
      sent.raw = new TextDecoder().decode(decodeBase64Url(body.raw));
      if (body.threadId) sent.threadId = body.threadId;
      return { json: { id: "sent-1", threadId: body.threadId ?? "new", labelIds: ["SENT"] } };
    }
    return undefined;
  };
}

function parseHeaders(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of raw.split("\r\n\r\n")[0]!.replace(/\r\n[ \t]+/g, " ").split("\r\n")) map.set(line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim());
  return map;
}

test("reply sets threading headers, subject and threadId", async () => {
  const sent: { raw?: string; threadId?: string } = {};
  const { gmail, calls } = setup(sentHandler(sent));
  const result = await gmail.reply({ messageId: "orig", text: "Thanks" });
  const headers = parseHeaders(sent.raw!);
  assert.equal(sent.threadId, "thread-9");
  assert.equal(headers.get("to"), "Alice <alice@x.com>");
  assert.equal(headers.get("subject"), "Re: Plan");
  assert.equal(headers.get("in-reply-to"), "<orig@mail>");
  assert.equal(headers.get("references"), "<r0@mail> <orig@mail>");
  assert.ok(!headers.has("cc"));
  assert.equal(result.id, "sent-1");
  assert.equal(result.messageIdHeader, headers.get("message-id"));
  assert.deepEqual(calls[0]!.url.searchParams.getAll("metadataHeaders").includes("Message-ID"), true);
});

test("replyAll excludes self and duplicates; Re: is not doubled; Reply-To wins", async () => {
  const sent: { raw?: string } = {};
  const { gmail } = setup((call) => {
    if (call.method === "GET") {
      const message = original({ headers: [header("Reply-To", "Alice Sales <sales@x.com>")] });
      message.payload.headers = message.payload.headers.map((item) => item.name === "Subject" ? header("Subject", "RE: Plan") : item);
      return { json: message };
    }
    return sentHandler(sent)(call);
  });
  await gmail.reply({ messageId: "orig", text: "ok", replyAll: true, selfEmail: "ME@example.com", cc: ["extra@x.com"] });
  const headers = parseHeaders(sent.raw!);
  assert.equal(headers.get("to"), "Alice Sales <sales@x.com>");
  assert.deepEqual(parseAddressList(headers.get("cc")!).map((address) => address.email), ["bob@x.com", "carol@x.com", "ALICE@x.com", "extra@x.com"]);
  assert.equal(headers.get("subject"), "RE: Plan");
});

test("forward re-attaches original attachments in a new, unthreaded message", async () => {
  const sent: { raw?: string; threadId?: string } = {};
  const pdf = Uint8Array.from([1, 2, 3, 250, 251]);
  const { gmail, calls } = setup((call) => {
    if (call.method === "GET" && path(call).endsWith("/messages/orig")) {
      return { json: {
        ...original(), internalDate: "1759708800000",
        payload: {
          mimeType: "multipart/mixed", headers: original().payload.headers.concat(header("Date", "Mon, 6 Oct 2025 00:00:00 +0000")),
          parts: [
            { partId: "0", mimeType: "text/plain", filename: "", body: { data: b64("Original text"), size: 13 } },
            { partId: "1", mimeType: "application/pdf", filename: "doc.pdf", body: { attachmentId: "att-1", size: 5 } },
            { partId: "2", mimeType: "image/png", filename: "logo.png", headers: [header("Content-ID", "<l>"), header("Content-Disposition", "inline")], body: { attachmentId: "att-2", size: 5 } },
          ],
        },
      } };
    }
    if (path(call).endsWith("/attachments/att-1")) return { json: { size: 5, data: b64(pdf) } };
    return sentHandler(sent)(call);
  });
  await gmail.forward({ messageId: "orig", to: ["dest@x.com"], text: "FYI" });
  assert.equal(sent.threadId, undefined);
  const headers = parseHeaders(sent.raw!);
  assert.equal(headers.get("subject"), "Fwd: Plan");
  assert.ok(!headers.has("in-reply-to"));
  assert.match(headers.get("content-type")!, /^multipart\/mixed/);
  assert.ok(sent.raw!.includes("filename=\"doc.pdf\""));
  assert.ok(!sent.raw!.includes("logo.png"), "inline images are not re-attached");
  assert.ok(sent.raw!.includes(Buffer.from(pdf).toString("base64")));
  const textBase64 = /Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(sent.raw!)![1]!.replace(/\r\n/g, "");
  const text = Buffer.from(textBase64, "base64").toString("utf8");
  assert.match(text, /^FYI\r\n\r\n---------- Forwarded message ---------\r\nFrom: Alice <alice@x.com>\r\nDate: Mon, 6 Oct 2025/);
  assert.match(text, /Subject: Plan\r\nTo: me@example.com, Bob <bob@x.com>\r\n\r\nOriginal text$/);
  assert.equal(calls.filter((call) => path(call).includes("/attachments/")).length, 1);
});

test("getAttachment resolves the current attachmentId by partId and handles inline data and unknown parts", async () => {
  const { gmail } = setup((call) => {
    if (path(call).endsWith("/attachments/fresh-id")) return { json: { size: 3, data: b64(Uint8Array.from([9, 8, 7])) } };
    return { json: { id: "m", threadId: "t", payload: { mimeType: "multipart/mixed", parts: [
      { partId: "1", mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "fresh-id", size: 3 } },
      { partId: "2", mimeType: "text/csv", filename: "b.csv", body: { data: b64("x,y"), size: 3 } },
      { partId: "3", mimeType: "application/zip", filename: "c.zip", body: { attachmentId: "z", size: 9_999_999 } },
    ] } } };
  });
  const pdf = await gmail.getAttachment("m", "1");
  assert.deepEqual([pdf.filename, pdf.mimeType, pdf.size, [...pdf.data]], ["a.pdf", "application/pdf", 3, [9, 8, 7]]);
  assert.equal(new TextDecoder().decode((await gmail.getAttachment("m", "2")).data), "x,y");
  await assert.rejects(gmail.getAttachment("m", "9"), (error: GoogleError) => error.code === "not-found");
  await assert.rejects(gmail.getAttachment("m", "3", { maxBytes: 1000 }), (error: GoogleError) => error.code === "too-large");
});

test("modify resolves label names case-insensitively and chooses the right endpoint", async () => {
  const { gmail, calls } = setup((call) => {
    if (path(call) === `${BASE}/labels`) return { json: { labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_7", name: "Receipts/2026", type: "user" }] } };
    return { json: {} };
  });
  assert.deepEqual(await gmail.modify({ messageIds: ["m1"], addLabels: ["receipts/2026"], removeLabels: ["INBOX"] }), { updated: 1 });
  const single = calls.find((call) => path(call).endsWith("/messages/m1/modify"))!;
  assert.deepEqual(JSON.parse(single.body), { addLabelIds: ["Label_7"], removeLabelIds: ["INBOX"] });
  assert.deepEqual(await gmail.modify({ messageIds: ["m1", "m2"], addLabels: ["Label_7"] }), { updated: 2 });
  const batch = calls.find((call) => path(call).endsWith("/messages/batchModify"))!;
  assert.deepEqual(JSON.parse(batch.body), { ids: ["m1", "m2"], addLabelIds: ["Label_7"], removeLabelIds: [] });
  await gmail.modify({ threadId: "t1", removeLabels: ["UNREAD"] });
  assert.ok(calls.some((call) => path(call).endsWith("/threads/t1/modify")));
  await assert.rejects(gmail.modify({ messageIds: ["m1"], addLabels: ["Nope"] }), (error: GoogleError) => error.code === "invalid-request" && error.message.includes("\"Nope\""));
  await assert.rejects(gmail.modify({ messageIds: ["m1"] }), (error: GoogleError) => error.code === "invalid-request");
});

test("trash and untrash pick message or thread endpoints", async () => {
  const { gmail, calls } = setup(() => ({ json: {} }));
  assert.deepEqual(await gmail.trash({ messageId: "m1" }), { ok: true });
  assert.deepEqual(await gmail.untrash({ threadId: "t1" }), { ok: true });
  assert.deepEqual(calls.map((call) => path(call).replace(BASE, "")), ["/messages/m1/trash", "/threads/t1/untrash"]);
});

test("send uses JSON raw for small messages and the upload endpoint above 5 MiB", async () => {
  const { gmail, calls } = setup((call) => ({ json: { id: "s", threadId: "t", labelIds: ["SENT"] }, status: call.method === "POST" ? 200 : 404 }));
  const small = await gmail.send({ to: ["a@example.com"], subject: "Hi", text: "body" });
  assert.equal(path(calls[0]!), `${BASE}/messages/send`);
  assert.ok(JSON.parse(calls[0]!.body).raw);
  assert.deepEqual([small.id, small.threadId, small.labelIds], ["s", "t", ["SENT"]]);
  assert.match(small.messageIdHeader, /^<.+@polyth\.local>$/);

  const big = new Uint8Array(4 * 1024 * 1024).fill(7); // ~5.6 MiB once base64-encoded
  await gmail.send({ to: ["a@example.com"], subject: "Big", text: "see attached", attachments: [{ filename: "big.bin", mimeType: "application/octet-stream", data: big }] });
  const upload = calls[1]!;
  assert.equal(path(upload), `${UPLOAD}/messages/send`);
  assert.equal(upload.url.searchParams.get("uploadType"), "media");
  assert.ok(upload.body.startsWith("To: a@example.com"));
  assert.equal(calls.length, 2);

  await gmail.send({ to: ["a@example.com"], subject: "Big", text: "x", threadId: "thr", attachments: [{ filename: "big.bin", mimeType: "application/octet-stream", data: big }] });
  assert.equal(calls[2]!.url.searchParams.get("uploadType"), "multipart");
  assert.match(calls[2]!.body, /\{"threadId":"thr"\}/);

  await assert.rejects(gmail.send({ to: [], subject: "x", text: "x" }), (error: GoogleError) => error.code === "invalid-request");
  const huge = new Uint8Array(27 * 1024 * 1024);
  await assert.rejects(
    gmail.send({ to: ["a@example.com"], subject: "x", text: "x", attachments: [{ filename: "h", mimeType: "application/octet-stream", data: huge }, { filename: "h2", mimeType: "application/octet-stream", data: huge }] }),
    (error: GoogleError) => error.code === "too-large",
  );
});

test("a 403 for missing scope surfaces as insufficient-scope", async () => {
  const { gmail } = setup(() => ({
    status: 403,
    json: { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } },
  }));
  await assert.rejects(gmail.search({ query: "x" }), (error: GoogleError) => error instanceof GoogleError && error.code === "insufficient-scope");
  await assert.rejects(gmail.trash({ messageId: "m" }), (error: GoogleError) => error.code === "insufficient-scope");
});

test("drafts: create as a reply, update, list, get, send and delete", async () => {
  const { gmail, calls } = setup((call) => {
    const p = path(call).replace(BASE, "");
    if (call.method === "GET" && p === "/messages/orig") return { json: original() };
    if (call.method === "POST" && p === "/drafts") return { json: { id: "d1", message: { id: "dm1", threadId: "thread-9", labelIds: ["DRAFT"] } } };
    if (call.method === "PUT" && p === "/drafts/d1") return { json: { id: "d1", message: { id: "dm2", threadId: "thread-9" } } };
    if (call.method === "GET" && p === "/drafts") return { json: { drafts: [{ id: "d1", message: { id: "dm2" } }, { id: "d2", message: { id: "gone" } }], resultSizeEstimate: 2 } };
    if (call.method === "GET" && p === "/messages/dm2") return { json: wireMessage("dm2", { labelIds: ["DRAFT"] }) };
    if (call.method === "GET" && p === "/messages/gone") return notFound;
    if (call.method === "GET" && p === "/drafts/d1") return { json: { id: "d1", message: wireMessage("dm2", { labelIds: ["DRAFT"], payload: { mimeType: "text/plain", headers: [header("Subject", "S")], body: { data: b64("draft text") } } }) } };
    if (call.method === "POST" && p === "/drafts/send") return { json: { id: "sent", threadId: "thread-9", labelIds: ["SENT"] } };
    if (call.method === "DELETE" && p === "/drafts/d1") return { json: undefined, status: 204 };
    return undefined;
  });
  const created = await gmail.createDraft({ to: [], subject: "", text: "draft", replyToMessageId: "orig" });
  assert.deepEqual([created.id, created.messageId, created.threadId], ["d1", "dm1", "thread-9"]);
  const body = JSON.parse(calls.find((call) => call.method === "POST")!.body) as { message: { raw: string; threadId: string } };
  assert.equal(body.message.threadId, "thread-9");
  const headers = parseHeaders(new TextDecoder().decode(decodeBase64Url(body.message.raw)));
  assert.equal(decodeHeaderWords(headers.get("subject")!), "Re: Plan");
  assert.equal(headers.get("in-reply-to"), "<orig@mail>");
  assert.equal(headers.get("to"), "Alice <alice@x.com>");
  assert.equal((await gmail.updateDraft("d1", { to: ["a@example.com"], subject: "New", text: "t" })).messageId, "dm2");
  const listed = await gmail.listDrafts({});
  assert.deepEqual(listed.drafts.map((draft) => [draft.id, draft.message.id]), [["d1", "dm2"]]);
  assert.equal((await gmail.getDraft("d1")).message.body, "draft text");
  assert.equal((await gmail.sendDraft("d1")).id, "sent");
  assert.deepEqual(await gmail.deleteDraft("d1"), { ok: true });
});

test("dot segments are rejected as Gmail ids instead of escaping the API path", async () => {
  let requests = 0;
  const gmail = createGmailService(createGoogleClient({
    tokens: { accessToken: async () => "t" },
    fetch: async () => { requests += 1; return new Response("{}", { status: 200 }); },
  }));
  await assert.rejects(gmail.getMessage(".."), { code: "invalid-request" });
  await assert.rejects(gmail.deleteDraft("."), { code: "invalid-request" });
  assert.equal(requests, 0);
});
