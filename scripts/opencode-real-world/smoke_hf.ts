/** Smoke: is the huggingface provider connected on real serve, and can
 *  gpt-oss-120b answer + call the bash tool + raise a permission? */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HF_MODEL, collectSse, httpJson, makeScratch, spawnServe, waitForAssistantCompletion, sleep } from "./lib.ts";

const main = async (): Promise<void> => {
  const scratch = await makeScratch("smoke-hf");
  const configDir = join(scratch.env.XDG_CONFIG_HOME!, "opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "opencode.json"), JSON.stringify({
    permission: { bash: "ask" },
  }));
  const serve = await spawnServe(scratch);
  try {
    const providers = await httpJson(serve.url, "GET", `/provider?directory=${encodeURIComponent(scratch.project)}`);
    const body = providers.body as { connected?: string[]; all?: Array<{ id: string }> };
    console.log("connected:", JSON.stringify(body.connected));
    const hf = (body.all ?? []).find((p) => p.id === "huggingface");
    console.log("hf models sample:", Object.keys((hf as { models?: Record<string, unknown> })?.models ?? {}).filter((m) => m.includes("gpt-oss")).join(", "));
    const sse = collectSse(serve.url, `/event?directory=${encodeURIComponent(scratch.project)}`);
    const created = await httpJson(serve.url, "POST", `/session?directory=${encodeURIComponent(scratch.project)}`, { title: "smoke" });
    const id = (created.body as { id: string }).id;
    const prompt = await httpJson(serve.url, "POST", `/session/${id}/prompt_async?directory=${encodeURIComponent(scratch.project)}`, {
      parts: [{ type: "text", text: "Run exactly this bash command using the bash tool: echo HF-SMOKE-MARKER" }],
      model: HF_MODEL,
    });
    console.log("prompt status:", prompt.status);
    const perm = await sse.waitFor((event) => event.type === "permission.asked", 60_000);
    console.log("permission.asked:", perm);
    if (perm) {
      const request = sse.events.findLast((event) => event.type === "permission.asked")!;
      const permId = (request.data as { properties?: { id?: string } }).properties?.id;
      const reply = await httpJson(serve.url, "POST", `/session/${id}/permissions/${permId}?directory=${encodeURIComponent(scratch.project)}`, { response: "once" });
      console.log("reply status:", reply.status);
    }
    const done = await waitForAssistantCompletion(serve.url, id, scratch.project, 60_000);
    const text = JSON.stringify(done.messages);
    console.log("completed:", done.completed, "marker:", text.includes("HF-SMOKE-MARKER"), "reasoningPresent:", text.includes('"reasoning"'));
    sse.close();
    await sleep(200);
  } finally {
    await serve.stop();
  }
};

await main();
