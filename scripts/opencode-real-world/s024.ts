/** OC-REAL-024: change global AGENTS.md behavior while idle and while a turn
 *  is active. Verify the next admitted turn reflects the new revision, the
 *  active turn is not restarted, and no serve restart happens at all
 *  (behavior application boundary is per-turn instruction loading). */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createConfigApplier } from "@polyth/backend-opencode";
import {
  LIVE_MODEL,
  LIVE_MODEL_ALT,
  collectSse,
  httpJson,
  makeScratch,
  sleep,
  spawnServe,
  waitForAssistantCompletion,
  writeEvidence,
  writeVerdict,
  OPENCODE_VERSION,
} from "./lib.ts";

const main = async (): Promise<void> => {
  const scratch = await makeScratch("OC-REAL-024");
  const failures: string[] = [];
  const configDir = join(scratch.env.XDG_CONFIG_HOME!, "opencode");
  const applier = createConfigApplier({ configDir });

  const behavior = (word: string): string =>
    `# Global behavior\n\nWhen the user sends exactly the word "ping", respond with exactly the word ${word} and nothing else. Do not use tools.\n`;
  await applier.applyBehavior(behavior("PONG-ALPHA"));

  const serve = await spawnServe(scratch);
  try {
    const startPid = serve.pid;
    const sse = collectSse(serve.url, `/event?directory=${encodeURIComponent(scratch.project)}`, join(scratch.logsDir, "sse.ndjson"));
    const created = await httpJson(serve.url, "POST", `/session?directory=${encodeURIComponent(scratch.project)}`, { title: "OC-REAL-024" });
    const id = (created.body as { id: string }).id;

    const lastAssistantText = async (): Promise<string> => {
      const result = await httpJson(serve.url, "GET", `/session/${id}/message?directory=${encodeURIComponent(scratch.project)}`);
      const rows = Array.isArray(result.body) ? result.body : [];
      const assistant = rows.filter((row) => (row as { info?: { role?: string } }).info?.role === "assistant").at(-1);
      return (((assistant as { parts?: Array<{ type?: string; text?: string }> })?.parts) ?? [])
        .filter((part) => part.type === "text").map((part) => part.text ?? "").join("").trim();
    };
    const turn = async (text: string, model = LIVE_MODEL): Promise<string> => {
      await httpJson(serve.url, "POST", `/session/${id}/prompt_async?directory=${encodeURIComponent(scratch.project)}`, {
        parts: [{ type: "text", text }],
        model,
      });
      await waitForAssistantCompletion(serve.url, id, scratch.project, 90_000);
      await sleep(400);
      return lastAssistantText();
    };

    // ---- turn 1 under ALPHA ----
    const reply1 = await turn("ping");
    if (!reply1.includes("PONG-ALPHA")) failures.push(`turn under ALPHA replied "${reply1.slice(0, 80)}"`);

    // ---- idle change ALPHA -> BETA; next turn must reflect it, same PID ----
    await applier.applyBehavior(behavior("PONG-BETA"));
    const reply2 = await turn("ping");
    if (!reply2.includes("PONG-BETA")) failures.push(`turn after idle behavior change replied "${reply2.slice(0, 80)}" (expected PONG-BETA)`);
    if (reply2.includes("PONG-ALPHA")) failures.push("stale ALPHA behavior after idle change");

    // ---- active-turn change: rewrite mid-turn; active turn unaffected ----
    await httpJson(serve.url, "POST", `/session/${id}/prompt_async?directory=${encodeURIComponent(scratch.project)}`, {
      parts: [{ type: "text", text: "Count from 1 to 300, one number per line. Do not use tools." }],
      model: LIVE_MODEL_ALT,
    });
    const busySeen = await sse.waitFor((event) =>
      event.type === "session.status"
      && (event.data as { properties?: { sessionID?: string; status?: { type?: string } } }).properties?.sessionID === id
      && (event.data as { properties?: { status?: { type?: string } } }).properties?.status?.type === "busy", 45_000);
    await applier.applyBehavior(behavior("PONG-GAMMA"));
    const activeDone = await waitForAssistantCompletion(serve.url, id, scratch.project, 120_000);
    const activeReply = await lastAssistantText();
    const activeAborted = JSON.stringify(activeDone.messages).includes("MessageAbortedError");
    if (!activeDone.completed || activeAborted) failures.push("active turn was interrupted by the behavior write");

    // ---- next turn must reflect GAMMA; PID never changed ----
    const reply4 = await turn("ping");
    if (!reply4.includes("PONG-GAMMA")) failures.push(`turn after mid-turn change replied "${reply4.slice(0, 80)}" (expected PONG-GAMMA)`);
    const endPid = serve.pid;
    const alive = serve.child.exitCode === null && serve.child.signalCode === null;
    if (!alive || endPid !== startPid) failures.push("serve process was restarted for a behavior change");

    const finalBytes = await readFile(applier.behaviorPath(), "utf8");
    await writeEvidence(scratch, "behavior-boundary.json", {
      behaviorPath: applier.behaviorPath(),
      replies: { alpha: reply1, beta: reply2, activeTail: activeReply.slice(-60), gamma: reply4 },
      busySeenDuringActiveWrite: busySeen,
      activeTurnCompleted: activeDone.completed,
      pidStable: endPid === startPid && alive,
      finalBehaviorBytes: finalBytes,
      failures,
    });
    await writeVerdict(scratch, {
      id: "OC-REAL-024",
      verdict: failures.length === 0 ? "pass" : "fail",
      opencodeVersion: OPENCODE_VERSION,
      protocol: "legacy (raw wire + config applier)",
      observed: `ALPHA->"${reply1.slice(0, 20)}"; idle change -> "${reply2.slice(0, 20)}"; mid-turn write left active turn completed=${activeDone.completed}; next turn -> "${reply4.slice(0, 20)}"; PID stable=${endPid === startPid}`,
      expected: "atomic write; behavior applies at next-turn boundary; no destructive restart",
      attribution: failures.length === 0 ? "NONE" : "AMBIGUITY",
      evidence: [
        "artifacts/opencode-real-world/phase-1-legacy/OC-REAL-024/behavior-boundary.json",
        "logs/opencode-real-world/phase-1-legacy/OC-REAL-024/sse.ndjson",
      ],
      notes: "Global AGENTS.md via createConfigApplier.applyBehavior (atomic tmp+rename). Unrelated-byte preservation of opencode.json is OC-REAL-025 scope; AGENTS.md is wholly owned.",
    });
    sse.close();
  } finally {
    await serve.stop();
  }
};

await main();
