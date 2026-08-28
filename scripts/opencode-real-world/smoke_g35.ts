/** Smoke: can OpenCode drive gemini-3.5-flash (not in models.dev catalog?)
 *  including a bash tool call with permission? */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectSse, httpJson, makeScratch, spawnServe, waitForAssistantCompletion, sleep } from "./lib.ts";

const MODEL = { providerID: "google", modelID: process.env.SMOKE_MODEL ?? "gemini-3.5-flash" };

const main = async (): Promise<void> => {
  const scratch = await makeScratch("smoke-g35");
  const configDir = join(scratch.env.XDG_CONFIG_HOME!, "opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "opencode.json"), JSON.stringify({ permission: { bash: "ask" } }));
  const serve = await spawnServe(scratch);
  try {
    const sse = collectSse(serve.url, `/event?directory=${encodeURIComponent(scratch.project)}`);
    const created = await httpJson(serve.url, "POST", `/session?directory=${encodeURIComponent(scratch.project)}`, { title: "smoke" });
    const id = (created.body as { id: string }).id;
    await httpJson(serve.url, "POST", `/session/${id}/prompt_async?directory=${encodeURIComponent(scratch.project)}`, {
      parts: [{ type: "text", text: "Run exactly this bash command using the bash tool: echo G35-SMOKE" }],
      model: MODEL,
    });
    const perm = await sse.waitFor((event) => event.type === "permission.asked", 45_000);
    console.log("permission.asked:", perm);
    if (perm) {
      const request = sse.events.findLast((event) => event.type === "permission.asked")!;
      const permId = (request.data as { properties?: { id?: string } }).properties?.id;
      await httpJson(serve.url, "POST", `/session/${id}/permissions/${permId}?directory=${encodeURIComponent(scratch.project)}`, { response: "once" });
    }
    const done = await waitForAssistantCompletion(serve.url, id, scratch.project, 60_000);
    const raw = JSON.stringify(done.messages);
    console.log("completed:", done.completed, "marker:", raw.includes("G35-SMOKE"), "error:", raw.includes("APIError"));
    const last = done.messages.at(-1) as { info?: { error?: unknown } };
    if (last?.info?.error) console.log("err:", JSON.stringify(last.info.error).slice(0, 300));
    sse.close();
    await sleep(200);
  } finally {
    await serve.stop();
  }
};

await main();
