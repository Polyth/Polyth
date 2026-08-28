// Phase-7 preflight smoke: boot real Polyth + owned OpenCode 1.18.18, create a
// session over HTTP, run one trivial turn, and watch it from two independent
// WS clients. Not a scenario — just proves the harness path end-to-end.
import { join } from "node:path";
import {
  HttpClient, MODEL, WsClient, closeRuntime, createIdleSession, makeScratch,
  openRuntime, restEvents, restoreEnvironment, serveForProject, waitFor,
  writeOpencodeConfig,
} from "./phase7lib.ts";

const scratch = await makeScratch("preflight");
await writeOpencodeConfig(scratch, { bash: "allow" });
let runtime;
try {
  runtime = await openRuntime(scratch);
  console.log("polyth on", runtime.baseUrl);
  const http = new HttpClient("smoke", runtime.baseUrl, join(scratch.logsDir, "smoke-http.ndjson"));
  const { projectId, sessionId } = await createIdleSession(http, scratch.project, "smoke");
  console.log("session", sessionId, "project", projectId);
  const serve = serveForProject(scratch.project);
  console.log("owned serve:", serve);

  const wsA = await WsClient.open("A", runtime.baseUrl, join(scratch.logsDir, "ws-a.ndjson"));
  const wsB = await WsClient.open("B", runtime.baseUrl, join(scratch.logsDir, "ws-b.ndjson"));
  wsA.subscribe(sessionId, projectId);
  wsB.subscribe(sessionId, projectId);

  const t0 = Date.now();
  const send = await http.call("POST", `/api/sessions/${sessionId}/message`, {
    text: "Reply with exactly the word PONG and nothing else.", model: MODEL,
  });
  console.log("send status", send.status, JSON.stringify(send.body).slice(0, 200));

  await wsA.waitForEvent((e) => e.sessionId === sessionId && e.type === "turn/stopped", 120_000, "turn stopped on A");
  await wsB.waitForEvent((e) => e.sessionId === sessionId && e.type === "turn/stopped", 10_000, "turn stopped on B");
  console.log(`turn completed in ${Date.now() - t0}ms`);

  const events = await restEvents(http, sessionId);
  console.log("event types:", events.map((e) => `${e.seq}:${e.type}`).join(" "));
  const wsATypes = wsA.eventsFor(sessionId).map((e) => `${e.seq}:${e.type}`);
  console.log("wsA events:", wsATypes.join(" "));
  await waitFor(async () => {
    const snap = await http.call("GET", `/api/sessions/${sessionId}`);
    return (snap.body as { status?: string }).status === "idle";
  }, 30_000, 250, "idle after turn");
  console.log("SMOKE OK");
  wsA.close();
  wsB.close();
} finally {
  await closeRuntime(runtime);
  restoreEnvironment();
}
