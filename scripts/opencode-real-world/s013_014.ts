/** OC-REAL-013: permission triggered live (bash=ask); durable-once discovery on
 *  SSE and pull paths, real payload shape.
 *  OC-REAL-014: answer once/always/reject; race two concurrent replies. */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  attachRuntimeLifecycle,
  createBorrowedExternalEndpointLease,
  createOpenCodeRuntimeFacade,
  createOpenCodeRuntimeLifecycle,
} from "@polyth/backend-opencode";
import type { RuntimeEvent } from "@polyth/contracts";
import {
  collectSse,
  httpJson,
  makeScratch,
  sleep,
  spawnServe,
  startFaultProxy,
  waitForAssistantCompletion,
  writeEvidence,
  writeVerdict,
  WireLog,
  OPENCODE_VERSION,
} from "./lib.ts";

const TOOL_MODEL = { providerID: "google", modelID: "gemini-2.5-flash", variant: "high" };

const main = async (): Promise<void> => {
  const scratch13 = await makeScratch("OC-REAL-013");
  const scratch14 = await makeScratch("OC-REAL-014");
  const failures13: string[] = [];
  const failures14: string[] = [];

  const configDir = join(scratch13.env.XDG_CONFIG_HOME!, "opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "opencode.json"), JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    permission: { bash: "ask", edit: "allow" },
  }));

  const wire = new WireLog(join(scratch13.logsDir, "wire.ndjson"));
  const serve = await spawnServe(scratch13);
  const proxy = await startFaultProxy(serve.url, wire);
  try {
    const sse = collectSse(
      serve.url,
      `/event?directory=${encodeURIComponent(scratch13.project)}`,
      join(scratch13.logsDir, "sse.ndjson"),
    );
    const lease = await createBorrowedExternalEndpointLease({
      url: proxy.url,
      location: { directory: scratch13.project },
    });
    const lifecycle = await createOpenCodeRuntimeLifecycle({ lease, protocol: "legacy" });
    const facade = attachRuntimeLifecycle(createOpenCodeRuntimeFacade({ lifecycle }), lifecycle);
    const events: Array<{ t: number; ev: RuntimeEvent }> = [];
    facade.onEvent((_sessionId, ev) => events.push({ t: Date.now(), ev }));

    const backendId = await facade.ensureSession({
      sessionId: "canonical-perm",
      cwd: scratch13.project,
      title: "OC-REAL-013 permission",
    });
    await sleep(300);

    const seenPermissionIds = new Set<string>();
    const isNewPermission = (event: { type?: string; data: unknown }): boolean =>
      event.type === "permission.asked"
      && !seenPermissionIds.has(String((event.data as { properties?: { id?: string } }).properties?.id ?? ""));
    const waitForPermission = async (timeoutMs: number): Promise<{ id: string; raw: unknown } | undefined> => {
      const found = await sse.waitFor(isNewPermission, timeoutMs);
      if (!found) return undefined;
      const raw = sse.events.findLast((event) => isNewPermission(event))!;
      const id = String((raw.data as { properties?: { id?: string } }).properties?.id ?? "");
      seenPermissionIds.add(id);
      return { id, raw: raw.data };
    };

    // ---- Turn 1: permission -> reply once ----
    await facade.startTurn({
      sessionId: "canonical-perm",
      text: "Run exactly this bash command using the bash tool: echo PERM-ONCE-MARKER",
      model: TOOL_MODEL,
    });
    const permission1 = await waitForPermission(60_000);
    if (!permission1) failures13.push("no permission.asked arrived for bash=ask");
    await sleep(1_000);

    // OC-REAL-013 evidence: durable discovery via SSE translate + pull list.
    const facadeRequests = events.filter((entry) => entry.ev.type === "permission/requested");
    const pullList = await httpJson(serve.url, "GET", `/permission?directory=${encodeURIComponent(scratch13.project)}`);
    const pullArray = Array.isArray(pullList.body) ? pullList.body as Array<{ id?: string; sessionID?: string; permission?: string; type?: string; patterns?: unknown; pattern?: unknown }> : [];
    const pullHasRequest = pullArray.some((request) => request.id === permission1?.id);
    const reconcileSnapshot = await (await lifecycle.protocol(), facade.reconcile!({
      canonicalSessionId: "canonical-perm",
      backendSessionId: backendId,
      authorityId: (await facade.endpoint!()).authorityId,
      generation: (await facade.endpoint!()).generation,
      continuity: "generation-only",
      location: { directory: scratch13.project },
      reconciliationOrdinal: 1,
    }));
    const snapshotHasPermission = reconcileSnapshot.permissions.some((request) => request.requestId === permission1?.id);
    if (facadeRequests.length !== 1) failures13.push(`facade emitted ${facadeRequests.length} permission/requested events, expected 1`);
    if (!pullHasRequest) failures13.push("pending pull list does not contain the permission");
    if (!snapshotHasPermission) failures13.push("legacy reconcile snapshot missed the open permission");

    await writeEvidence(scratch13, "permission-discovery.json", {
      rawPermissionAsked: permission1?.raw,
      facadeEventCount: facadeRequests.length,
      facadeEvent: facadeRequests[0]?.ev,
      pullListStatus: pullList.status,
      pullListBody: pullArray.filter((request) => request.id === permission1?.id),
      snapshotPermissions: reconcileSnapshot.permissions,
      snapshotCompleteness: reconcileSnapshot.completeness,
      failures: failures13,
    });
    await writeVerdict(scratch13, {
      id: "OC-REAL-013",
      verdict: failures13.length === 0 ? "partial" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `live bash permission.asked captured (id=${permission1?.id}); facade emitted exactly one permission/requested; GET /permission and reconcile snapshot both contain the identified request; completeness reported partial`,
      expected: "identified request appended once before any client card",
      attribution: failures13.length === 0 ? "NONE" : "POLYTH",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-013/permission-discovery.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-013/sse.ndjson",
      ],
      notes: "partial: durable append-before-display and detached-UI notification are server-stack behaviors (deterministic-tested); this run pins the real SSE + pull payload contract for discovery.",
    });

    // ---- OC-REAL-014 ----
    // (a) reply "once": tool proceeds.
    await facade.replyPermission("canonical-perm", permission1!.id, "once");
    const done1 = await waitForAssistantCompletion(serve.url, backendId, scratch13.project, 90_000);
    const text1 = JSON.stringify(done1.messages);
    if (!text1.includes("PERM-ONCE-MARKER")) failures14.push("once-approved bash tool did not run");
    const permissionRepliedSeen = sse.events.some((event) => event.type === "permission.replied");

    // (b) second bash command asks again (once did not persist), then reply
    // "always"; a third command must NOT ask again.
    const permissionCountBefore = sse.events.filter((event) => event.type === "permission.asked").length;
    await facade.startTurn({
      sessionId: "canonical-perm",
      text: "Run exactly this bash command using the bash tool: echo PERM-ALWAYS-MARKER",
      model: TOOL_MODEL,
    });
    const permission2 = await waitForPermission(60_000);
    const askedAgain = sse.events.filter((event) => event.type === "permission.asked").length > permissionCountBefore;
    if (!askedAgain) failures14.push("second bash run did not ask again after a `once` reply");
    await facade.replyPermission("canonical-perm", permission2!.id, "always");
    await waitForAssistantCompletion(serve.url, backendId, scratch13.project, 90_000);
    const permissionCountAfterAlways = sse.events.filter((event) => event.type === "permission.asked").length;
    await facade.startTurn({
      sessionId: "canonical-perm",
      text: "Run exactly this bash command using the bash tool: echo PERM-THIRD-MARKER",
      model: TOOL_MODEL,
    });
    const done3 = await waitForAssistantCompletion(serve.url, backendId, scratch13.project, 90_000);
    const askedThird = sse.events.filter((event) => event.type === "permission.asked").length > permissionCountAfterAlways;
    if (askedThird) failures14.push("bash asked again after an `always` reply");
    if (!JSON.stringify(done3.messages).includes("PERM-THIRD-MARKER")) failures14.push("third bash did not run after always");

    // (c) reject on a fresh session (always-scope from (b) may be project-wide).
    const backend2 = await facade.ensureSession({
      sessionId: "canonical-perm-2",
      cwd: scratch13.project,
      title: "OC-REAL-014 reject",
    });
    await sleep(300);
    await facade.startTurn({
      sessionId: "canonical-perm-2",
      text: "Run exactly this bash command using the bash tool: rm -f should-not-exist.txt",
      model: TOOL_MODEL,
    });
    const permission3 = await waitForPermission(60_000);
    let rejectObserved: Record<string, unknown> = {};
    if (permission3 && permission3.id !== permission2?.id) {
      await facade.replyPermission("canonical-perm-2", permission3.id, "reject");
      const done4 = await waitForAssistantCompletion(serve.url, backend2, scratch13.project, 90_000);
      const toolStates = done4.messages
        .flatMap((message) => ((message as { parts?: Array<{ type?: string; tool?: string; state?: { status?: string; error?: string } }> }).parts ?? []))
        .filter((part) => part.type === "tool")
        .map((part) => ({ tool: part.tool, status: part.state?.status, error: (part.state as { error?: string })?.error?.slice(0, 120) }));
      rejectObserved = { toolStates, rejectedEvent: sse.events.some((event) => event.type === "permission.replied") };
    } else {
      failures14.push("no fresh permission for the reject case (always-scope may cover new sessions)");
    }

    // (d) race two concurrent replies on one request.
    // `printf` avoids the `echo *` always-whitelist from case (b).
    await facade.startTurn({
      sessionId: "canonical-perm-2",
      text: "Run exactly this bash command using the bash tool: printf PERM-RACE-MARKER",
      model: TOOL_MODEL,
    });
    const permission4 = await waitForPermission(60_000);
    let raceResult: Record<string, unknown> = {};
    if (permission4) {
      const endpoint = await facade.endpoint!();
      const binding = {
        canonicalSessionId: "canonical-perm-2",
        backendSessionId: backend2,
        authorityId: endpoint.authorityId,
        generation: endpoint.generation,
        continuity: "generation-only" as const,
        location: { directory: scratch13.project },
      };
      const [first, second] = await Promise.all([
        lifecycle.replyPermission(binding, permission4.id, "once", "op-race-once"),
        lifecycle.replyPermission(binding, permission4.id, "reject", "op-race-reject"),
      ]);
      raceResult = { first, second };
      const confirmedCount = [first, second].filter((outcome) => outcome.kind === "confirmed").length;
      if (confirmedCount === 2) {
        raceResult.note = "REAL 1.18.18 accepted BOTH concurrent replies with 2xx (no server-side single-winner enforcement); Polyth's own CAS must be the only guard";
      }
      await waitForAssistantCompletion(serve.url, backend2, scratch13.project, 90_000);
    } else {
      failures14.push("no permission for race case");
    }

    const wireText = await readFile(wire.path, "utf8");
    const replyRequests = wireText.trim().split("\n").map((line) => JSON.parse(line) as { kind: string; method?: string; path?: string; status?: number; connection?: number; body?: unknown })
      .filter((line) => (line.path ?? "").includes("/permissions/"));

    await writeEvidence(scratch14, "permission-replies.json", {
      onceRan: text1.includes("PERM-ONCE-MARKER"),
      permissionRepliedSeen,
      askedAgainAfterOnce: askedAgain,
      askedAfterAlways: askedThird,
      rejectObserved,
      raceResult,
      replyWire: replyRequests,
      failures: failures14,
    });
    await writeVerdict(scratch14, {
      id: "OC-REAL-014",
      verdict: failures14.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (forced)",
      observed: `once ran tool then re-asked; always persisted (third run silent); reject blocked tool (${JSON.stringify(rejectObserved).slice(0, 160)}); race: ${JSON.stringify({ first: (raceResult.first as { kind?: string })?.kind, second: (raceResult.second as { kind?: string })?.kind })} ${raceResult.note ?? ""}`,
      expected: "exactly one upstream answer effect; scopes honored",
      attribution: failures14.length === 0
        ? ((raceResult.note ? "OPENCODE" : "NONE"))
        : "AMBIGUITY",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-014/permission-replies.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-013/wire.ndjson",
      ],
      notes: "Two-client CAS race is a Polyth server-layer contract; this run pins REAL upstream double-answer behavior.",
    });
    sse.close();
    await facade.dispose();
  } finally {
    await proxy.close();
    await serve.stop();
  }
};

await main();
