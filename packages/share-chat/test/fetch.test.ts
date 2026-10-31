import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import type { PinnedHttpRequest, PinnedHttpResult } from "@polyth/outbound";
import { fetchSharePage, SHARE_FETCH_USER_AGENT, type ShareHttpTransport } from "../src/fetch.ts";

const SHARE = "https://chatgpt.com/share/6f0c2a1e-1234-4abc-9def-0123456789ab";
const resolve = async () => ["93.184.215.14"];
const code = (expected: string) => (cause: unknown) => (cause as { code?: string }).code === expected;

function respond(status: number, body: string | Buffer = "", headers: Record<string, string> = {}): PinnedHttpResult {
  return {
    status,
    headers: new Headers({ "content-type": "text/html; charset=utf-8", ...headers }),
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
  };
}

function scripted(...responses: Array<PinnedHttpResult | Error>): { transport: ShareHttpTransport; calls: Array<{ url: string; init: PinnedHttpRequest }> } {
  const calls: Array<{ url: string; init: PinnedHttpRequest }> = [];
  return {
    calls,
    transport: async (url, _addresses, init) => {
      calls.push({ url: url.toString(), init });
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("reads a share page through same-host redirects and decompresses it", async () => {
  const { transport, calls } = scripted(
    respond(301, "", { location: `${SHARE}?ref=1` }),
    respond(200, gzipSync(Buffer.from("<html>ok – ✓</html>")), { "content-encoding": "gzip" }),
  );
  const page = await fetchSharePage("https://chat.openai.com/share/6F0C2A1E-1234-4ABC-9DEF-0123456789AB", { resolve, transport });
  assert.equal(page.url, SHARE);
  assert.equal(page.finalUrl, `${SHARE}?ref=1`);
  assert.equal(page.adapter.id, "chatgpt");
  assert.equal(page.html, "<html>ok – ✓</html>");
  assert.equal(calls[0]!.url, SHARE);
  assert.equal(calls[0]!.init.method, "GET");
  assert.equal(calls[0]!.init.headers?.["user-agent"], SHARE_FETCH_USER_AGENT);
  assert.equal(calls[0]!.init.headers?.cookie, undefined);
  assert.equal(calls[0]!.init.maxBytes, 8 * 1024 * 1024);
});

test("refuses redirects that leave the share host", async () => {
  const { transport } = scripted(respond(302, "", { location: "https://auth.example.com/login" }));
  await assert.rejects(fetchSharePage(SHARE, { resolve, transport }), code("unsupported-host"));
});

test("maps HTTP failures to http-<status>", async () => {
  await assert.rejects(fetchSharePage(SHARE, { resolve, transport: scripted(respond(404, "missing")).transport }), (cause: Error & { code?: string }) =>
    cause.code === "http-404" && /not found/.test(cause.message));
  await assert.rejects(fetchSharePage(SHARE, { resolve, transport: scripted(respond(403)).transport }), (cause: Error & { code?: string }) =>
    cause.code === "http-403" && /refused/.test(cause.message));
  await assert.rejects(fetchSharePage(SHARE, { resolve, transport: scripted(respond(302)).transport }), code("http-302"));
});

test("enforces the size cap on the wire and after decompression", async () => {
  const wire = Object.assign(new Error("response exceeds limit"), { code: "INVALID_REQUEST" });
  await assert.rejects(fetchSharePage(SHARE, { resolve, transport: scripted(wire).transport }), code("too-large"));
  const bomb = gzipSync(Buffer.alloc(64 * 1024, "a"));
  await assert.rejects(
    fetchSharePage(SHARE, { resolve, maxBytes: 4 * 1024, transport: scripted(respond(200, bomb, { "content-encoding": "gzip" })).transport }),
    code("too-large"),
  );
});

test("times out and honours caller cancellation", async () => {
  const hang: ShareHttpTransport = (_url, _addresses, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  });
  await assert.rejects(fetchSharePage(SHARE, { resolve, transport: hang, timeoutMs: 30 }), code("timeout"));
  const controller = new AbortController();
  const pending = fetchSharePage(SHARE, { resolve, transport: hang, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, code("aborted"));
});

test("rejects non-page bodies, private addresses and unreachable hosts", async () => {
  await assert.rejects(
    fetchSharePage(SHARE, { resolve, transport: scripted(respond(200, "%PDF", { "content-type": "application/pdf" })).transport }),
    code("unreadable-page"),
  );
  await assert.rejects(
    fetchSharePage(SHARE, { resolve, transport: scripted(respond(200, Buffer.from([60, 0, 1, 2]))).transport }),
    code("unreadable-page"),
  );
  await assert.rejects(fetchSharePage(SHARE, { resolve: async () => ["10.0.0.5"], transport: scripted().transport }), code("blocked"));
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  await assert.rejects(fetchSharePage(SHARE, { resolve, transport: scripted(reset).transport }), code("network"));
  await assert.rejects(fetchSharePage("https://example.com/share/x", { resolve, transport: scripted().transport }), code("unsupported-host"));
});
