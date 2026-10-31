import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CODE_INTELLIGENCE_LANGUAGES,
  CODE_INTELLIGENCE_PROVIDER_ID,
  CODE_INTELLIGENCE_ROUTE,
  createTypeScriptIntelligence,
  type CodeIntelligenceRequest,
  type FetchLike,
} from "../src/index.ts";
import { EDITOR_INTELLIGENCE_CHANGED_EVENT } from "../../editor/widgets/intelligence.ts";

const request: CodeIntelligenceRequest = {
  ref: {
    scheme: "file",
    locator: "src/app.ts",
    projectId: "project-1",
    sessionId: "session-2",
    repositoryId: "primary",
  },
  path: "src/app.ts",
  language: "TypeScript",
  content: "const answer = 42;\nanswer\n",
  contentRevision: "rev-7",
  position: { line: 1, character: 6 },
};

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

function recordingFetch(
  respond: (capability: unknown, call: Call) => Response | Promise<Response>,
  calls: Call[],
): FetchLike {
  return async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const call: Call = {
      url: input,
      method: init?.method ?? "GET",
      body,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return await respond(body.capability, call);
  };
}

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

test("the provider serves exactly the editor's four JavaScript/TypeScript labels", () => {
  const provider = createTypeScriptIntelligence(async () => json({}));
  assert.equal(provider.id, CODE_INTELLIGENCE_PROVIDER_ID);
  assert.deepEqual([...provider.languages], [...CODE_INTELLIGENCE_LANGUAGES]);
  assert.deepEqual([...provider.languages], ["JavaScript", "JavaScript (JSX)", "TypeScript", "TypeScript (TSX)"]);
});

test("each capability POSTs the editor route with the request fields", async () => {
  const calls: Call[] = [];
  const provider = createTypeScriptIntelligence(recordingFetch(() => json({
    completions: { from: { line: 1, character: 0 }, items: [{ label: "answer", kind: "variable" }] },
    hover: { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }, display: "const answer: number" },
    diagnostics: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } }, severity: "warning", message: "unused", code: 6133 }],
  }), calls));

  const completions = await provider.completions(request);
  const hover = await provider.hover(request);
  const diagnostics = await provider.diagnostics(request);

  assert.deepEqual(calls.map((call) => [call.url, call.method, call.body.capability]), [
    [CODE_INTELLIGENCE_ROUTE, "POST", "completion"],
    [CODE_INTELLIGENCE_ROUTE, "POST", "hover"],
    [CODE_INTELLIGENCE_ROUTE, "POST", "diagnostics"],
  ]);
  for (const call of calls) {
    assert.equal(call.body.projectId, "project-1");
    assert.equal(call.body.sessionId, "session-2");
    assert.equal(call.body.repositoryId, "primary");
    assert.equal(call.body.path, "src/app.ts");
    assert.deepEqual(call.body.position, { line: 1, character: 6 });
    assert.equal(call.body.content, "const answer = 42;\nanswer\n");
    assert.equal(call.body.contentRevision, "rev-7");
    // The editor's ResourceRef never leaks into the wire body.
    assert.equal("ref" in call.body, false);
  }
  assert.deepEqual(completions, { from: { line: 1, character: 0 }, items: [{ label: "answer", kind: "variable" }] });
  assert.equal(hover?.display, "const answer: number");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.severity, "warning");
});

test("an absent repository id defaults to the primary repository", async () => {
  const calls: Call[] = [];
  const provider = createTypeScriptIntelligence(recordingFetch(() => json({}), calls));
  await provider.completions({ ...request, ref: { ...request.ref, repositoryId: undefined } });
  assert.equal(calls[0]?.body.repositoryId, "primary");
});

test("an unavailable service or a non-2xx response degrades to an empty result", async () => {
  const unavailable = createTypeScriptIntelligence(async () => json({ unavailable: "language", capability: "hover" }));
  assert.equal(await unavailable.hover(request), null);
  assert.deepEqual(await unavailable.diagnostics(request), []);
  assert.equal(await unavailable.completions(request), null);

  const failing = createTypeScriptIntelligence(async () => new Response("nope", { status: 503 }));
  assert.equal(await failing.hover(request), null);
  assert.deepEqual(await failing.diagnostics(request), []);
  assert.equal(await failing.completions(request), null);
});

test("a malformed body or a thrown fetch never rejects", async () => {
  const garbage = createTypeScriptIntelligence(async () => new Response("not json", { status: 200 }));
  assert.equal(await garbage.hover(request), null);
  assert.deepEqual(await garbage.diagnostics(request), []);

  const throwing = createTypeScriptIntelligence(async () => { throw new Error("offline"); });
  assert.equal(await throwing.completions(request), null);
  assert.equal(await throwing.hover(request), null);
  assert.deepEqual(await throwing.diagnostics(request), []);

  const empty = createTypeScriptIntelligence(async () => json({ completions: null, hover: null, diagnostics: null }));
  assert.equal(await empty.completions(request), null);
  assert.deepEqual(await empty.diagnostics(request), []);
});

test("a completion with no items is null; items pass through untouched", async () => {
  const empty = createTypeScriptIntelligence(async () => json({ completions: { from: { line: 0, character: 0 }, items: [] } }));
  assert.equal(await empty.completions(request), null);

  const items = [
    { label: "alpha", kind: "function", insertText: "alpha()" },
    { label: "beta", kind: "variable", detail: "number", sortText: "0" },
  ];
  const populated = createTypeScriptIntelligence(async () => json({ completions: { from: { line: 1, character: 0 }, items, incomplete: true } }));
  assert.deepEqual(await populated.completions(request), { from: { line: 1, character: 0 }, items, incomplete: true });
});

test("an aborted signal is passed to fetch and never reaches the editor as an error", async () => {
  const calls: Call[] = [];
  const provider = createTypeScriptIntelligence(recordingFetch(() => json({ completions: { from: { line: 0, character: 0 }, items: [{ label: "x", kind: "text" }] } }), calls));
  const controller = new AbortController();
  controller.abort();
  assert.equal(await provider.completions(request, controller.signal), null);
  assert.equal(calls.length, 0, "an already-aborted request is never sent");

  const live = new AbortController();
  await provider.completions(request, live.signal);
  assert.equal(calls[0]?.signal, live.signal);
});

test("the package announces a slot change with the editor's event name", async () => {
  assert.equal(EDITOR_INTELLIGENCE_CHANGED_EVENT, "polyth:editor-intelligence");
  const entry = await readFile(new URL("../widgets/index.tsx", import.meta.url), "utf8");
  assert.match(entry, /EDITOR_INTELLIGENCE_CHANGED_EVENT = "polyth:editor-intelligence"/);
  assert.match(entry, /slot: "editor\.intelligence"/);
  assert.match(entry, /render: \(\) => null/);
  assert.match(entry, /meta: \{ provider \}/);
});
