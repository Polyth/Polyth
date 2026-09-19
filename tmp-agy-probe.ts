import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { RuntimeEvent } from "@polyth/contracts";
import type { HarnessProcessAuthority } from "@polyth/harness-runtime/process-authority";
import { createAntigravityRuntime } from "./packages/backend-antigravity/src/runtime.ts";

const cwd = "/tmp/agy-test";
const model = { providerID: "antigravity", modelID: "gemini-3.8-flash-low", variant: "low" } as const;
const descriptor = {
  harnessId: "antigravity", providerID: "antigravity", modelID: "gemini-3.8-flash-low",
  name: "Gemini 3.8 Flash (Low)", providerName: "Google Antigravity",
  capabilities: ["input:text", "output:text", "toolcall"], variants: ["low", "medium", "high"],
};
const context = { spaceId: "space-a", projectId: "project-a", sessionId: "session-a", cwd, model } as never;

const children: ChildProcess[] = [];
const authority: HarnessProcessAuthority = {
  authorityId: "probe-authority", generation: 1, receipts: {}, releasedAuthorities: [], durable: false,
  spawn(command, args, options) {
    const child = spawn(command, args, options);
    children.push(child);
    child.stderr?.resume();
    return child;
  },
  async receipt(id, value) { authority.receipts[id] = value; },
  async close() { for (const c of children) c.kill("SIGKILL"); },
};

const events: RuntimeEvent[] = [];
const runtime = createAntigravityRuntime({
  context, authority, command: "agy", models: async () => [descriptor as never], timeoutMs: 60_000,
});
runtime.onEvent((_id, event) => {
  console.log("EVENT", event.type, JSON.stringify(event).slice(0, 220));
  events.push(event);
});
runtime.onLifecycle((event) => console.log("LIFECYCLE", JSON.stringify(event)));

const created = await runtime.createSessionOperation!({ ...(context as object), sessionId: "session-a" } as never, "create-1");
console.log("CREATE", JSON.stringify(created));

const run = async (id: string, text: string) => {
  const outcome = await runtime.startTurnOperation!({ sessionId: "session-a", text, model } as never, id);
  console.log("ADMISSION", id, JSON.stringify(outcome));
  if (outcome.kind !== "confirmed") return;
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (events.some((e) => e.type === "turn/stopped" && (e as { turnId?: string }).turnId === id)) {
        clearInterval(t); resolve(undefined);
      }
    }, 200);
    setTimeout(() => { clearInterval(t); resolve(undefined); }, 90_000);
  });
};

await run("turn-1", "Use invoke_subagent to delegate this: compute 2+2. Report the subagent's answer.");
console.log("--- after turn 1, connected? start turn 2 ---");
await run("turn-2", "Reply with exactly: SECOND");
console.log("--- done ---");
console.log("stop reasons", events.filter((e) => e.type === "turn/stopped").map((e) => JSON.stringify(e)));
await runtime.dispose();
process.exit(0);
