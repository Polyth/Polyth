/** One-off: dump raw part structure of a gpt-oss assistant reply. */
import { HF_MODEL, httpJson, makeScratch, spawnServe, waitForAssistantCompletion } from "./lib.ts";

const main = async (): Promise<void> => {
  const scratch = await makeScratch("probe-parts");
  const serve = await spawnServe(scratch);
  try {
    const created = await httpJson(serve.url, "POST", `/session?directory=${encodeURIComponent(scratch.project)}`, { title: "probe" });
    const id = (created.body as { id: string }).id;
    await httpJson(serve.url, "POST", `/session/${id}/prompt_async?directory=${encodeURIComponent(scratch.project)}`, {
      parts: [{ type: "text", text: "Reply with exactly the word SAME and nothing else." }],
      model: HF_MODEL,
    });
    const done = await waitForAssistantCompletion(serve.url, id, scratch.project, 60_000);
    for (const message of done.messages) {
      const info = (message as { info?: { role?: string; id?: string } }).info;
      const parts = (message as { parts?: Array<Record<string, unknown>> }).parts ?? [];
      console.log(info?.role, info?.id, JSON.stringify(parts.map((part) => ({ type: part.type, text: typeof part.text === "string" ? (part.text as string).slice(0, 60) : undefined, keys: Object.keys(part) })), null, 1));
    }
    await new Promise((r) => setTimeout(r, 3000));
    const refetch = await httpJson(serve.url, "GET", `/session/${id}/message?directory=${encodeURIComponent(scratch.project)}`);
    console.log("REFETCH after 3s:");
    for (const message of (refetch.body as Array<Record<string, unknown>>)) {
      const info = message.info as { role?: string; id?: string; time?: unknown; error?: unknown };
      const parts = (message.parts as Array<Record<string, unknown>>) ?? [];
      console.log(info?.role, info?.id, "time:", JSON.stringify(info?.time), "err:", JSON.stringify(info?.error));
      console.log("  parts:", JSON.stringify(parts.map((part) => ({ type: part.type, text: typeof part.text === "string" ? (part.text as string).slice(0, 80) : undefined }))));
    }
  } finally {
    await serve.stop();
  }
};

await main();
