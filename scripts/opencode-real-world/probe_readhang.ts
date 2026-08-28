/** Repro: does the read tool hang on a nonexistent path? */
import { LIVE_MODEL, collectSse, httpJson, makeScratch, spawnServe, sleep } from "./lib.ts";

const main = async (): Promise<void> => {
  const scratch = await makeScratch("probe-readhang");
  const serve = await spawnServe(scratch);
  try {
    const sse = collectSse(serve.url, `/event?directory=${encodeURIComponent(scratch.project)}`);
    const created = await httpJson(serve.url, "POST", `/session?directory=${encodeURIComponent(scratch.project)}`, { title: "readhang" });
    const id = (created.body as { id: string }).id;
    await httpJson(serve.url, "POST", `/session/${id}/prompt_async?directory=${encodeURIComponent(scratch.project)}`, {
      parts: [{ type: "text", text: "Use the read tool to read the file /nonexistent/missing-probe.txt. Then tell me in one sentence what happened." }],
      model: LIVE_MODEL,
    });
    const start = Date.now();
    const deadline = start + 120_000;
    let lastLog = "";
    while (Date.now() < deadline) {
      const idle = sse.events.some((event) => event.type === "session.idle");
      const toolEvents = sse.events.filter((event) => {
        const part = (event.data as { properties?: { part?: { type?: string; state?: { status?: string } } } }).properties?.part;
        return event.type === "message.part.updated" && part?.type === "tool";
      }).map((event) => {
        const part = (event.data as { properties?: { part?: { tool?: string; state?: { status?: string; error?: string } } } }).properties?.part;
        return `${part?.tool}:${part?.state?.status}${part?.state?.error ? `(${part.state.error.slice(0, 60)})` : ""}`;
      });
      const log = JSON.stringify(toolEvents);
      if (log !== lastLog) {
        console.log(`t+${Date.now() - start}ms tools:`, log);
        lastLog = log;
      }
      if (idle) {
        console.log(`IDLE at t+${Date.now() - start}ms`);
        break;
      }
      await sleep(500);
    }
    const messages = await httpJson(serve.url, "GET", `/session/${id}/message?directory=${encodeURIComponent(scratch.project)}`);
    const parts = (Array.isArray(messages.body) ? messages.body : [])
      .flatMap((message) => ((message as { parts?: Array<Record<string, unknown>> }).parts ?? []));
    console.log("final parts:", JSON.stringify(parts.map((part) => ({ type: part.type, tool: part.tool, status: (part.state as { status?: string })?.status, err: String((part.state as { error?: string })?.error ?? "").slice(0, 80), text: typeof part.text === "string" ? (part.text as string).slice(0, 80) : undefined }))));
    sse.close();
  } finally {
    await serve.stop();
  }
};

await main();
