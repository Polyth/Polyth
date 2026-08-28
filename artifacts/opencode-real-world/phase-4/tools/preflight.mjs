// Preflight: prove the harness plumbing against the real product + real
// OpenCode. No fault injected. Confirms model catalog and one live prompt.
import { writeFileSync } from "node:fs";
import {
  api, dumpDb, eventsOf, readPidRecord, scenarioSetup, sleep, snapshotOf,
  startPolyth, stopPolyth, timeline, waitFor,
} from "./lib.mjs";

const ctx = scenarioSetup("preflight", 15140);
const polyth = await startPolyth(ctx, { label: "polyth" });
try {
  const project = (await api(ctx, "POST", "/api/projects", { path: ctx.dirs.project, name: "preflight" })).json;
  console.log("project", project);
  const models = (await api(ctx, "GET", "/api/models", undefined, { timeoutMs: 60000 })).json;
  console.log("model count", Array.isArray(models) ? models.length : models);
  const interesting = (Array.isArray(models) ? models : [])
    .filter((m) => m.connected !== false)
    .map((m) => `${m.providerID ?? m.provider}/${m.modelID ?? m.id} connected=${m.connected} reasoning=${JSON.stringify(m.reasoning ?? m.variants ?? null)}`);
  writeFileSync("/tmp/ocreal/phase-4/preflight-models.txt", interesting.join("\n"));
  console.log(interesting.slice(0, 40).join("\n"));

  const pidRecord = readPidRecord(ctx.dirs.project);
  console.log("pid record", pidRecord);

  const model = { providerID: process.env.PRE_PROVIDER ?? "google", modelID: process.env.PRE_MODEL ?? "gemini-2.5-flash" };
  const session = (await api(ctx, "POST", "/api/sessions", { projectId: project.id, title: "preflight", model })).json;
  console.log("session", session);
  const send = await api(ctx, "POST", `/api/sessions/${session.id}/message`, {
    text: "Reply with exactly the text PREFLIGHT_OK and nothing else.",
  }, { timeoutMs: 60000 });
  console.log("send", send.status, JSON.stringify(send.json).slice(0, 300));
  await waitFor(async () => {
    const events = await eventsOf(ctx, session.id);
    const types = events.map((e) => e.type);
    console.log("events so far:", types.join(","));
    return types.some((t) => t === "assistant/message" || t === "turn/stopped") ? events : undefined;
  }, { timeoutMs: 90000, intervalMs: 3000, what: "assistant reply" });
  const finalEvents = await eventsOf(ctx, session.id);
  console.log(JSON.stringify(finalEvents.map((e) => ({ seq: e.seq, type: e.type, data: JSON.stringify(e.data).slice(0, 120) })), null, 2));
  console.log("snapshot", JSON.stringify(await snapshotOf(ctx, session.id)).slice(0, 400));
  dumpDb(ctx, "preflight", session.id);
} finally {
  await stopPolyth(ctx, polyth);
  timeline(ctx, { event: "preflight-done" });
}
