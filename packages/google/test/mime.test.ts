import assert from "node:assert/strict";
import test from "node:test";
import { GoogleError } from "../src/http.ts";
import {
  collectAttachments,
  composeMessage,
  decodeBase64Url,
  decodeHeaderWords,
  encodeBase64Url,
  encodeHeaderWords,
  extractBody,
  htmlToText,
  parseAddressList,
} from "../src/mime.ts";
import type { GmailMessagePart } from "../src/mime.ts";

const b64 = (text: string | Uint8Array): string => encodeBase64Url(text);
const textPart = (mimeType: string, data: string | Uint8Array, headers: GmailMessagePart["headers"] = [], partId = "0"): GmailMessagePart => ({
  partId, mimeType, filename: "", headers: headers.some((header) => header.name === "Content-Type") ? headers : [{ name: "Content-Type", value: mimeType }, ...headers], body: { size: 1, data: b64(data) },
});

test("base64url round trips and is unpadded", () => {
  const bytes = Uint8Array.from([0xfb, 0xff, 0xfe, 0x00, 0x41]);
  const encoded = encodeBase64Url(bytes);
  assert.ok(!/[+/=]/.test(encoded));
  assert.deepEqual([...decodeBase64Url(encoded)], [...bytes]);
  assert.equal(new TextDecoder().decode(decodeBase64Url(encodeBase64Url("Привіт"))), "Привіт");
});

test("extractBody prefers text/plain inside mixed > alternative", () => {
  const payload: GmailMessagePart = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "multipart/alternative", partId: "0", parts: [textPart("text/plain", "plain body", [], "0.0"), textPart("text/html", "<p>html body</p>", [], "0.1")] },
      { partId: "1", mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "x", size: 10 } },
    ],
  };
  assert.deepEqual(extractBody(payload, { maxChars: 1000 }), { body: "plain body", format: "text", truncated: false });
});

test("extractBody converts html when there is no plain text and truncates", () => {
  const payload = textPart("text/html", "<html><head><style>p{}</style></head><body><p>Hello&nbsp;<b>world</b></p><script>x()</script><a href=\"https://e.com/x\">link</a></body></html>");
  const result = extractBody(payload, { maxChars: 1000 });
  assert.equal(result.format, "html-converted");
  assert.equal(result.body, "Hello world\nlink (https://e.com/x)");
  const cut = extractBody(textPart("text/plain", "abcdefghij"), { maxChars: 4 });
  assert.deepEqual(cut, { body: "abcd", format: "text", truncated: true });
});

test("extractBody decodes non-UTF-8 charsets and unknown charsets never throw", () => {
  const cp1251 = Uint8Array.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // Привет
  const decoded = extractBody(textPart("text/plain", cp1251, [{ name: "Content-Type", value: "text/plain; charset=windows-1251" }]), { maxChars: 100 });
  assert.equal(decoded.body, "Привет");
  const latin2 = Uint8Array.from([0xbe, 0x6c, 0x75, 0x74, 0x6f, 0x75, 0xe8, 0x6b, 0xfd]); // žlutoučký
  assert.equal(extractBody(textPart("text/plain", latin2, [{ name: "Content-Type", value: "text/plain; charset=\"iso-8859-2\"" }]), { maxChars: 100 }).body, "žlutoučký");
  const unknown = extractBody(textPart("text/plain", "ok", [{ name: "Content-Type", value: "text/plain; charset=x-nonsense" }]), { maxChars: 100 });
  assert.equal(unknown.body, "ok");
});

test("extractBody skips attachment text parts and survives malformed payloads", () => {
  const payload: GmailMessagePart = {
    mimeType: "multipart/mixed",
    parts: [textPart("text/plain", "body"), { ...textPart("text/plain", "notes", [], "1"), filename: "notes.txt" }],
  };
  assert.equal(extractBody(payload, { maxChars: 100 }).body, "body");
  for (const bad of [{}, { mimeType: "multipart/mixed" }, { mimeType: "text/plain", body: { data: "!!!" } }, { parts: [null as unknown as GmailMessagePart] }]) {
    assert.doesNotThrow(() => extractBody(bad as GmailMessagePart, { maxChars: 10 }));
    assert.doesNotThrow(() => collectAttachments(bad as GmailMessagePart));
  }
  assert.deepEqual(extractBody({}, { maxChars: 10 }), { body: "", format: "none", truncated: false });
});

test("htmlToText handles blocks, entities and unterminated markup", () => {
  assert.equal(htmlToText("<div>a</div><div>b</div><br><br><br><br><p>c &amp; d &#x41;&#66; &lt;x&gt;</p>"), "a\nb\n\nc & d AB <x>");
  assert.equal(htmlToText("<ul><li>one</li><li>two</li></ul>"), "one\ntwo");
  assert.equal(htmlToText("text <b unterminated"), "text <b unterminated");
  assert.equal(htmlToText("<!-- hidden -->shown"), "shown");
  assert.equal(htmlToText("<a href=\"javascript:alert(1)\">x</a>"), "x");
  const started = Date.now();
  htmlToText(`${"<".repeat(5000)}${"a ".repeat(50_000)}`);
  assert.ok(Date.now() - started < 2000);
});

test("collectAttachments finds files, synthesizes names and detects inline parts", () => {
  const payload: GmailMessagePart = {
    mimeType: "multipart/mixed",
    partId: "",
    parts: [
      { partId: "0", mimeType: "multipart/related", parts: [
        textPart("text/html", "<img src=cid:logo>", [], "0.0"),
        { partId: "0.1", mimeType: "image/png", filename: "logo.png", headers: [{ name: "Content-ID", value: "<logo@x>" }], body: { attachmentId: "a1", size: 5 } },
      ] },
      { partId: "1", mimeType: "application/pdf", filename: "", body: { attachmentId: "a2", size: 99 } },
      { partId: "2", mimeType: "application/zip", filename: "r.zip", headers: [{ name: "Content-Disposition", value: "attachment; filename=r.zip" }], body: { attachmentId: "a3", size: 7 } },
      { partId: "3", mimeType: "text/plain", filename: "", body: { attachmentId: "big", size: 99999 } },
    ],
  };
  assert.deepEqual(collectAttachments(payload), [
    { partId: "0.1", attachmentId: "a1", filename: "logo.png", mimeType: "image/png", size: 5, inline: true, contentId: "logo@x" },
    { partId: "1", attachmentId: "a2", filename: "attachment-1.pdf", mimeType: "application/pdf", size: 99, inline: false },
    { partId: "2", attachmentId: "a3", filename: "r.zip", mimeType: "application/zip", size: 7, inline: false },
  ]);
});

test("RFC 2047 words decode (B, Q, adjacent) and Ukrainian subjects round trip", () => {
  assert.equal(decodeHeaderWords("=?UTF-8?B?0J/RgNC40LLRltGC?= plain"), "Привіт plain");
  assert.equal(decodeHeaderWords("=?iso-8859-1?Q?Caf=E9_au_lait?="), "Café au lait");
  assert.equal(decodeHeaderWords("=?UTF-8?B?0J/RgNC4?=  =?UTF-8?B?0LLRltGC?="), "Привіт");
  assert.equal(decodeHeaderWords("=?x-unknown?B?SGk=?="), "Hi");
  const subject = "Рахунок за жовтень: ґанок, їжак, єдність — 🎉 ".repeat(4);
  const encoded = encodeHeaderWords(subject);
  for (const line of encoded.split("\r\n ")) assert.ok(line.length <= 75, line);
  assert.equal(decodeHeaderWords(encoded), subject);
});

test("parseAddressList handles quoted commas, encoded names, bare addresses and garbage", () => {
  assert.deepEqual(parseAddressList("\"Doe, John\" <john@example.com>, jane@example.com, =?UTF-8?B?0IbQstCw0L0=?= <ivan@ex.ua>, not an address, <bare@x.org>"), [
    { name: "Doe, John", email: "john@example.com" },
    { email: "jane@example.com" },
    { name: "Іван", email: "ivan@ex.ua" },
    { email: "bare@x.org" },
  ]);
  assert.deepEqual(parseAddressList("Team: a@x.com, b@x.com;, Bob (work) <bob@x.com>"), [
    { email: "a@x.com" }, { email: "b@x.com" }, { name: "Bob", email: "bob@x.com" },
  ]);
  assert.deepEqual(parseAddressList(""), []);
});

test("composeMessage rejects header injection and invalid addresses", () => {
  const base = { to: ["a@example.com"], subject: "s", text: "t" };
  const code = (input: Parameters<typeof composeMessage>[0]) => {
    try { composeMessage(input); } catch (error) { return error instanceof GoogleError ? error.code : String(error); }
    return "no error";
  };
  assert.equal(code({ ...base, subject: "x\r\nBcc: evil@example.com" }), "invalid-request");
  assert.equal(code({ ...base, to: ["a@example.com\nBcc: e@x.com"] }), "invalid-request");
  assert.equal(code({ ...base, inReplyTo: "<a@b>\r\nX: y" }), "invalid-request");
  assert.equal(code({ ...base, attachments: [{ filename: "a\r\nb", mimeType: "text/plain", data: new Uint8Array() }] }), "invalid-request");
  assert.equal(code({ ...base, to: ["not an email"] }), "invalid-request");
  assert.equal(code({ ...base, to: ["a b@example.com"] }), "invalid-request");
  assert.equal(code({ ...base, to: ["<a@example.com"] }), "invalid-request");
  assert.equal(code(base), "no error");
});

function unfold(raw: string): { headers: Map<string, string>; body: string } {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const headers = new Map<string, string>();
  for (const line of head!.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const at = line.indexOf(":");
    headers.set(line.slice(0, at).toLowerCase(), line.slice(at + 1).trim());
  }
  return { headers, body: rest.join("\r\n\r\n") };
}

function splitParts(contentType: string, body: string): string[] {
  const boundary = /boundary="([^"]+)"/.exec(contentType)![1]!;
  return body.split(`--${boundary}`).slice(1, -1).map((part) => part.replace(/^\r\n/, "").replace(/\r\n$/, ""));
}

test("composed multipart message with attachment parses back", () => {
  const data = Uint8Array.from({ length: 300 }, (_, index) => index % 251);
  const { raw, messageId } = composeMessage({
    to: ["\"Doe, John\" <john@example.com>", "Іван <ivan@example.com>"],
    cc: ["c@example.com"],
    bcc: ["b@example.com"],
    subject: "Рахунок за жовтень",
    text: "Привіт\nсвіте",
    html: "<p>Привіт</p>",
    attachments: [{ filename: "звіт.pdf", mimeType: "application/pdf", data }],
    inReplyTo: "<orig@x>",
    references: "<r1@x> <orig@x>",
  });
  assert.ok(/^<[0-9a-f]+@polyth\.local>$/.test(messageId));
  assert.ok(!/[^\x00-\x7f]/.test(raw), "message must be pure ASCII");
  assert.ok(raw.split("\r\n").every((line) => line.length <= 998));
  const top = unfold(raw);
  assert.equal(top.headers.get("message-id"), messageId);
  assert.equal(top.headers.get("mime-version"), "1.0");
  assert.equal(top.headers.get("in-reply-to"), "<orig@x>");
  assert.equal(top.headers.get("references"), "<r1@x> <orig@x>");
  assert.equal(top.headers.get("subject"), `=?UTF-8?B?${Buffer.from("Рахунок за жовтень").toString("base64")}?=`);
  assert.equal(decodeHeaderWords(top.headers.get("subject")!), "Рахунок за жовтень");
  assert.deepEqual(parseAddressList(top.headers.get("to")!), [{ name: "Doe, John", email: "john@example.com" }, { name: "Іван", email: "ivan@example.com" }]);
  assert.ok(!top.headers.has("from") && !top.headers.has("date"));
  assert.match(top.headers.get("content-type")!, /^multipart\/mixed;/);
  const [bodyPart, attachment] = splitParts(top.headers.get("content-type")!.replace(/\s+/g, " "), top.body);
  const alt = unfold(bodyPart!);
  assert.match(alt.headers.get("content-type")!, /^multipart\/alternative;/);
  const [plain, html] = splitParts(alt.headers.get("content-type")!, alt.body).map(unfold);
  assert.equal(Buffer.from(plain!.body.replace(/\r\n/g, ""), "base64").toString("utf8"), "Привіт\r\nсвіте");
  assert.equal(Buffer.from(html!.body.replace(/\r\n/g, ""), "base64").toString("utf8"), "<p>Привіт</p>");
  const file = unfold(attachment!);
  assert.match(file.headers.get("content-disposition")!, /^attachment; filename="[^"]*"; filename\*=UTF-8''%D0%B7%D0%B2%D1%96%D1%82\.pdf$/);
  assert.ok(file.body.split("\r\n").every((line) => line.length <= 76));
  assert.deepEqual([...Buffer.from(file.body.replace(/\r\n/g, ""), "base64")], [...data]);
});

test("composeMessage formats names, plain ascii attachments and honors a given Message-ID", () => {
  const { raw, messageId } = composeMessage({
    from: "Me <me@example.com>",
    to: ["A. Smith <a@example.com>"],
    subject: "plain",
    text: "hi",
    messageId: "fixed@polyth.local",
    attachments: [{ filename: "a.txt", mimeType: "text/plain", data: new TextEncoder().encode("x") }],
  });
  assert.equal(messageId, "<fixed@polyth.local>");
  const top = unfold(raw);
  assert.equal(top.headers.get("from"), "Me <me@example.com>");
  assert.equal(top.headers.get("to"), "\"A. Smith\" <a@example.com>");
  assert.equal(top.headers.get("subject"), "plain");
  assert.match(raw, /Content-Disposition: attachment; filename="a\.txt"\r\n/);
});
