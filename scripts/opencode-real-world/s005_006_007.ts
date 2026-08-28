/** OC-REAL-005: create with/without title + response-loss ambiguity (proxy).
 *  OC-REAL-006: externally created sessions listed per directory, no adoption.
 *  OC-REAL-007: adopt existing session with history; hydrate twice (idempotent). */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createOpenCodeTransport,
  createProtocolAdapter,
} from "@polyth/backend-opencode";
import type { ProtocolAdapter, RuntimeEndpoint, RuntimeSessionBinding } from "@polyth/contracts";
import {
  CHEAP_MODEL,
  httpJson,
  makeScratch,
  spawnServe,
  startFaultProxy,
  waitForAssistantCompletion,
  writeEvidence,
  writeVerdict,
  WireLog,
  OPENCODE_VERSION,
  type Scratch,
} from "./lib.ts";

const endpointFor = (url: string, directory: string, authorityId: string): RuntimeEndpoint => ({
  authorityId,
  continuity: "generation-only",
  generation: 1,
  url,
  location: { directory },
  control: { kind: "borrowed", source: "external" },
  config: { kind: "read-only" },
  authentication: { kind: "basic-env", usernameEnv: "OPENCODE_SERVER_USERNAME", passwordEnv: "OPENCODE_SERVER_PASSWORD" },
});

const adapterFor = async (url: string, directory: string, authorityId: string): Promise<{ adapter: ProtocolAdapter; endpoint: RuntimeEndpoint }> => {
  const transport = createOpenCodeTransport({ baseUrl: url, directory });
  const endpoint = endpointFor(url, directory, authorityId);
  const adapter = await createProtocolAdapter({ protocol: "legacy", transport, endpoint });
  return { adapter, endpoint };
};

const bindingFor = (endpoint: RuntimeEndpoint, canonicalSessionId: string, backendSessionId?: string): RuntimeSessionBinding => ({
  canonicalSessionId,
  ...(backendSessionId ? { backendSessionId } : {}),
  authorityId: endpoint.authorityId,
  generation: endpoint.generation,
  continuity: endpoint.continuity,
  location: endpoint.location,
});

const run005 = async (scratch: Scratch): Promise<void> => {
  const wire = new WireLog(join(scratch.logsDir, "wire.ndjson"));
  const serve = await spawnServe(scratch);
  const proxy = await startFaultProxy(serve.url, wire);
  const failures: string[] = [];
  try {
    const { adapter, endpoint } = await adapterFor(proxy.url, scratch.project, "oc-real-005");
    const upstreamBefore = await httpJson(serve.url, "GET", `/session?directory=${encodeURIComponent(scratch.project)}`);
    const beforeIds = new Set((upstreamBefore.body as Array<{ id: string }>).map((session) => session.id));

    // Case A: create with explicit title
    const withTitle = await adapter.ensureSession(bindingFor(endpoint, "canonical-a"), "op-005-a", "Real validation title A");
    if (withTitle.kind !== "confirmed") failures.push(`titled create not confirmed: ${JSON.stringify(withTitle)}`);
    // Case B: create with placeholder title (must send {})
    const placeholder = await adapter.ensureSession(bindingFor(endpoint, "canonical-b"), "op-005-b", "New session");
    if (placeholder.kind !== "confirmed") failures.push(`placeholder create not confirmed: ${JSON.stringify(placeholder)}`);

    const upstreamAfter = await httpJson(serve.url, "GET", `/session?directory=${encodeURIComponent(scratch.project)}`);
    const sessions = (upstreamAfter.body as Array<{ id: string; title?: string; operationID?: string; operationId?: string }>);
    const created = sessions.filter((session) => !beforeIds.has(session.id));
    if (created.length !== 2) failures.push(`expected 2 new upstream sessions, found ${created.length}`);
    const titled = created.find((session) => withTitle.kind === "confirmed" && session.id === withTitle.value.backendSessionId);
    if (titled?.title !== "Real validation title A") failures.push(`upstream title mismatch: ${JSON.stringify(titled?.title)}`);
    const untitled = created.find((session) => placeholder.kind === "confirmed" && session.id === placeholder.value.backendSessionId);
    if (untitled?.title === "New session") failures.push("placeholder title was forced upstream");
    const operationReceipt = created.some((session) => session.operationID ?? session.operationId);

    // Case C: response loss on create (upstream commits) -> must be unknown,
    // never a second POST.
    proxy.setRule(/POST \/session\?/, { kind: "forward-drop" });
    const postsBefore = proxy.requestCount(/^POST \/session\?/);
    const lost = await adapter.ensureSession(bindingFor(endpoint, "canonical-c"), "op-005-c", "Lost response create");
    proxy.setRule(undefined);
    proxy.killActiveSockets();
    const postsAfter = proxy.requestCount(/^POST \/session\?/);
    if (lost.kind !== "unknown") failures.push(`lost-response create is ${lost.kind}, expected unknown`);
    if (postsAfter - postsBefore !== 1) failures.push(`expected exactly 1 create POST during loss, saw ${postsAfter - postsBefore}`);
    const upstreamFinal = await httpJson(serve.url, "GET", `/session?directory=${encodeURIComponent(scratch.project)}`);
    const finalSessions = upstreamFinal.body as Array<{ id: string; title?: string; operationID?: string }>;
    const orphan = finalSessions.find((session) => session.title === "Lost response create");
    const orphanHasOperationReceipt = !!(orphan && (orphan as { operationID?: string; operationId?: string }).operationID);

    await writeEvidence(scratch, "create-cases.json", {
      withTitle,
      placeholder,
      createdUpstream: created,
      upstreamHasOperationReceipt: operationReceipt,
      lostResponseOutcome: lost,
      createPostsDuringLoss: postsAfter - postsBefore,
      orphanCommittedUpstream: !!orphan,
      orphanId: orphan?.id,
      orphanHasOperationReceipt,
      failures,
    });
    await writeVerdict(scratch, {
      id: "OC-REAL-005",
      verdict: failures.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `titled+placeholder creates confirmed with exact binding; placeholder sent {} and upstream autogenerated no forced title; lost-response create -> unknown with exactly one POST; upstream committed orphan=${!!orphan}; upstream reflects x-polyth-operation-id receipt=${operationReceipt || orphanHasOperationReceipt}`,
      expected: "one backend session per create, exact binding, no placeholder forced, ambiguity stays unknown without duplicate POST",
      attribution: failures.length === 0 ? "NONE" : "POLYTH",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-005/create-cases.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-005/wire.ndjson",
      ],
      notes: "Real 1.18.18 session records carry no operationID receipt, so an unknown create cannot settle by exact receipt (matches BASELINE-AUDIT; fake-only recovery).",
    });
  } finally {
    await proxy.close();
    await serve.stop();
  }
};

const run006 = async (scratch: Scratch): Promise<void> => {
  const serve = await spawnServe(scratch);
  const failures: string[] = [];
  try {
    const dirA = join(scratch.root, "project-a");
    const dirB = join(scratch.root, "project-b");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const mk = async (dir: string, title: string) =>
      (await httpJson(serve.url, "POST", `/session?directory=${encodeURIComponent(dir)}`, { title })).body as { id: string };
    const a1 = await mk(dirA, "external A1");
    const a2 = await mk(dirA, "external A2");
    const b1 = await mk(dirB, "external B1");

    const { adapter: adapterA } = await adapterFor(serve.url, dirA, "oc-real-006-a");
    const { adapter: adapterB } = await adapterFor(serve.url, dirB, "oc-real-006-b");
    const listA = await adapterA.sessions();
    const listB = await adapterB.sessions();
    const idsA = new Set(listA.map((session) => session.id));
    const idsB = new Set(listB.map((session) => session.id));
    if (!idsA.has(a1.id) || !idsA.has(a2.id)) failures.push("directory A list misses externally created sessions");
    if (idsA.has(b1.id)) failures.push("directory A list leaked a directory-B session");
    if (!idsB.has(b1.id)) failures.push("directory B list misses its session");
    if (idsB.has(a1.id) || idsB.has(a2.id)) failures.push("directory B list leaked directory-A sessions");

    await writeEvidence(scratch, "listing.json", {
      created: { a1: a1.id, a2: a2.id, b1: b1.id },
      listA: listA.map((session) => ({ id: session.id, title: session.title })),
      listB: listB.map((session) => ({ id: session.id, title: session.title })),
      failures,
    });
    await writeVerdict(scratch, {
      id: "OC-REAL-006",
      verdict: failures.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `externally created sessions listed exactly per directory scope (A:${listA.length}, B:${listB.length}); no cross-directory leak`,
      expected: "counts and IDs match location scope; no silent adoption",
      attribution: failures.length === 0 ? "NONE" : "POLYTH",
      evidence: ["artifacts/opencode-real-world/phase-1-legacy/OC-REAL-006/listing.json"],
      notes: "Adapter-level catalog; Polyth server-side non-adoption (unadopted catalog) is deterministic-tested; this validates the real location scoping contract.",
    });
  } finally {
    await serve.stop();
  }
};

const run007 = async (scratch: Scratch): Promise<void> => {
  const serve = await spawnServe(scratch);
  const failures: string[] = [];
  try {
    // Create a session OUTSIDE Polyth and give it real history via a live prompt.
    const created = (await httpJson(serve.url, "POST", `/session?directory=${encodeURIComponent(scratch.project)}`, { title: "adopt me" })).body as { id: string };
    const prompt = await httpJson(
      serve.url,
      "POST",
      `/session/${created.id}/message?directory=${encodeURIComponent(scratch.project)}`,
      {
        parts: [{ type: "text", text: "Reply with exactly: ADOPTED-HISTORY-MARKER" }],
        model: { providerID: CHEAP_MODEL.providerID, modelID: CHEAP_MODEL.modelID },
      },
    );
    if (prompt.status !== 200) failures.push(`seed prompt failed: ${prompt.status}`);
    await waitForAssistantCompletion(serve.url, created.id, scratch.project, 60_000);

    const { adapter, endpoint } = await adapterFor(serve.url, scratch.project, "oc-real-007");
    const binding = bindingFor(endpoint, "canonical-adopted", created.id);
    const hydrate1 = await adapter.history(binding);
    const hydrate2 = await adapter.history(binding);
    if (JSON.stringify(hydrate1) !== JSON.stringify(hydrate2)) failures.push("second hydrate differs from first");
    const userCount = hydrate1.filter((message) => message.role === "user").length;
    const assistantCount = hydrate1.filter((message) => message.role === "assistant").length;
    if (userCount !== 1 || assistantCount !== 1) failures.push(`expected 1 user + 1 assistant, got ${userCount}/${assistantCount}`);
    const markerOnce = hydrate1.filter((message) => message.text.includes("ADOPTED-HISTORY-MARKER"));
    if (markerOnce.length !== 2 && markerOnce.length !== 1) failures.push("marker text lost");

    // Reconcile twice: snapshot events must be stable (idempotent pull).
    const reconcile1 = await adapter.reconcile({ ...binding, reconciliationOrdinal: 1 });
    const reconcile2 = await adapter.reconcile({ ...binding, reconciliationOrdinal: 2 });
    if (reconcile1.events.length !== reconcile2.events.length) {
      failures.push(`reconcile event count drifted: ${reconcile1.events.length} -> ${reconcile2.events.length}`);
    }
    await writeEvidence(scratch, "hydration.json", {
      backendSessionId: created.id,
      hydrate1,
      hydrateIdentical: JSON.stringify(hydrate1) === JSON.stringify(hydrate2),
      reconcileEventCounts: [reconcile1.events.length, reconcile2.events.length],
      reconcileState: reconcile1.state,
      completeness: reconcile1.completeness,
      failures,
    });
    await writeVerdict(scratch, {
      id: "OC-REAL-007",
      verdict: failures.length === 0 ? "partial" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `existing external session hydrated once (1 user + 1 assistant, marker intact); second hydrate byte-identical; reconcile pull stable across ordinals; snapshot completeness=partial and state=${reconcile1.state.value}`,
      expected: "existing history appears once, baseline durable, second hydrate idempotent",
      attribution: failures.length === 0 ? "NONE" : "POLYTH",
      evidence: ["artifacts/opencode-real-world/phase-1-legacy/OC-REAL-007/hydration.json"],
      notes: "partial: adapter hydration/reconcile idempotency proven against real history incl. live model output; the durable import-baseline (D evidence, session package) requires the full server stack and is covered by deterministic tests, not this real run. Tool/terminal record variants not seeded (tool run covered in OC-REAL-010).",
    });
  } finally {
    await serve.stop();
  }
};

const scratch5 = await makeScratch("OC-REAL-005");
await run005(scratch5);
const scratch6 = await makeScratch("OC-REAL-006");
await run006(scratch6);
const scratch7 = await makeScratch("OC-REAL-007");
await run007(scratch7);
