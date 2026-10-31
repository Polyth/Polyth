import type { ServerResponse } from "node:http";
import type { SessionReplayPage } from "@polyth/contracts";

/** Legacy JSON-array response, with bounded reads and socket backpressure. */
export async function streamHistoryResponse(
  res: ServerResponse,
  read: (cursor: number, highWater?: number) => Promise<SessionReplayPage>,
  afterSeq: number,
): Promise<void> {
  let cursor = afterSeq;
  let highWater: number | undefined;
  let first = true;
  while (!res.destroyed) {
    const page = await read(cursor, highWater);
    if (res.destroyed) return;
    highWater ??= page.highWater;
    if (page.highWater !== highWater || page.cursor < cursor || (!page.complete && page.cursor === cursor)) {
      throw Object.assign(new Error("history cursor did not advance"), { code: "conflict" });
    }
    if (!res.headersSent) res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    const body = `${first ? "[" : page.events.length ? "," : ""}${page.events.map((event) => JSON.stringify(event)).join(",")}${page.complete ? "]" : ""}`;
    if (page.events.length) first = false;
    if (!res.write(body)) await new Promise<void>((resolve) => {
      const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
      res.once("drain", done); res.once("close", done);
    });
    if (page.complete) { res.end(); return; }
    cursor = page.cursor;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
