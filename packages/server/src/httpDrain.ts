import type { Server } from "node:http";

/** Bound for waiting on `server.close()` before destroying leftover sockets. */
export const HTTP_DRAIN_MS = 8_000;

const raceUntil = async (
  done: Promise<unknown>,
  ms: number,
): Promise<"done" | "timeout"> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<"done" | "timeout">((resolve) => {
      const markDone = () => resolve("done");
      void done.then(markDone, markDone);
      timer = setTimeout(() => resolve("timeout"), ms);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** Stop accepting, wait for in-flight HTTP to finish, then force-close anything
 *  that would otherwise pin `server.close()` forever (idle keep-alive, a WS
 *  peer that ignores the close handshake). Idempotent and bounded.
 *  Destroying sockets is not the same as application-handler completion —
 *  pass `untilIdle` to wait on request JS, then fence remaining handlers. */
export async function drainAndCloseServer(
  server: Server,
  opts?: {
    timeoutMs?: number;
    untilIdle?: (timeoutMs: number) => Promise<boolean>;
  },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? HTTP_DRAIN_MS;
  if (!server.listening) {
    try { server.closeAllConnections(); } catch { /* already down */ }
    return;
  }

  let finished = false;
  const closed = new Promise<void>((resolve) => {
    server.close(() => {
      finished = true;
      resolve();
    });
  });
  try { server.closeIdleConnections(); } catch { /* Node < 18.2 */ }

  const idle = opts?.untilIdle?.(timeoutMs) ?? Promise.resolve(true);
  await raceUntil(Promise.all([closed, idle]), timeoutMs);
  if (finished && await idle) return;
  try { server.closeAllConnections(); } catch { /* already down */ }
  await raceUntil(closed, 250);
}
