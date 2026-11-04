// The /ws handshake costs a round trip or two, and the app graph takes a few
// hundred milliseconds (much longer on a phone) to evaluate before init()
// creates the SyncClient. Once the server has proven an authorized, ready
// installation (the auth status inlined into the HTML shell), the socket starts
// in parallel with that evaluation and the SyncClient adopts it.
//
// Nothing is sent before adoption: what to subscribe to stays the client's
// decision. Frames that arrive early (broadcasts) are replayed to the adopter's
// handlers in order, after it has installed them.
import type { WebSocketLike } from "./sync.ts";

/** An early socket nobody adopted (boot took another path) is let go. */
const UNCLAIMED_CLOSE_MS = 15_000;
const WS_CLOSING = 2;

type Backlog = Array<{ kind: "open" | "message" | "error" | "close"; event: Event }>;

interface EarlySocket {
  url: string;
  socket: WebSocketLike;
  backlog: Backlog;
  timer: ReturnType<typeof setTimeout>;
  openedAt: number | null;
}

let early: EarlySocket | null = null;
let adoptedOpenedAt: number | null = null;

const clock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

function detach(socket: WebSocketLike): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
}

function discard(record: EarlySocket): void {
  if (early !== record) return;
  early = null;
  clearTimeout(record.timer);
  detach(record.socket);
  try { record.socket.close(); } catch { /* already gone */ }
}

/** The /ws URL of this page's origin. */
export function syncSocketUrl(where: Pick<Location, "protocol" | "host"> = location): string {
  return `${where.protocol === "https:" ? "wss" : "ws"}://${where.host}/ws`;
}

/** Start the socket early. At most one per document; a no-op without WebSocket. */
export function preconnectSync(
  url: string,
  create: (url: string) => WebSocketLike = (target) => new WebSocket(target),
): void {
  if (early !== null) return;
  let socket: WebSocketLike;
  try { socket = create(url); } catch { return; }
  const record: EarlySocket = {
    url,
    socket,
    backlog: [],
    timer: setTimeout(() => discard(record), UNCLAIMED_CLOSE_MS),
    openedAt: null,
  };
  socket.onopen = (event) => {
    record.openedAt = clock();
    record.backlog.push({ kind: "open", event });
  };
  socket.onmessage = (event) => { record.backlog.push({ kind: "message", event }); };
  socket.onerror = (event) => { record.backlog.push({ kind: "error", event }); };
  socket.onclose = (event) => { record.backlog.push({ kind: "close", event }); };
  early = record;
}

/**
 * The early socket for `url`, at most once. It is returned in place of a new
 * one (a `SyncClientOptions.webSocket` factory); the handlers the caller
 * installs right away receive the backlog in order on the next microtask. A
 * socket that already failed is dropped, so the caller dials at once instead
 * of starting from a failure and its backoff.
 */
export function adoptPreconnectedSync(url: string): WebSocketLike | null {
  const record = early;
  if (record === null) return null;
  if (record.url !== url || record.socket.readyState >= WS_CLOSING
    || record.backlog.some((entry) => entry.kind === "close" || entry.kind === "error")) {
    discard(record);
    return null;
  }
  early = null;
  clearTimeout(record.timer);
  adoptedOpenedAt = record.openedAt;
  const { socket, backlog } = record;
  let replaying = true;
  const adopted: WebSocketLike = {
    get readyState() { return socket.readyState; },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (data) => socket.send(data),
    // The close event still reaches the adopter: its error path closes and
    // then retries from that event.
    close: (code, reason) => socket.close(code, reason),
  };
  const deliver = (kind: Backlog[number]["kind"], event: Event): void => {
    if (kind === "open") adopted.onopen?.(event);
    else if (kind === "message") adopted.onmessage?.(event as MessageEvent);
    else if (kind === "error") adopted.onerror?.(event);
    else adopted.onclose?.(event as CloseEvent);
  };
  const route = (kind: Backlog[number]["kind"]) => (event: Event) => {
    if (replaying) backlog.push({ kind, event });
    else deliver(kind, event);
  };
  socket.onopen = route("open");
  socket.onmessage = route("message");
  socket.onerror = route("error");
  socket.onclose = route("close");
  queueMicrotask(() => {
    // Entries that land while replaying join the same queue, so order holds.
    for (let entry = backlog.shift(); entry; entry = backlog.shift()) deliver(entry.kind, entry.event);
    replaying = false;
  });
  return adopted;
}

/** True when the adopted socket was already open at `at` (performance.now()
 *  clock): the server was delivering broadcasts to it before anything this
 *  document read after that moment, so those reads cannot have missed one. */
export function adoptedSocketOpenBefore(at: number): boolean {
  return adoptedOpenedAt !== null && adoptedOpenedAt <= at;
}

/** Test seam: forget this document's early socket. */
export function resetPreconnectForTest(): void {
  if (early !== null) discard(early);
  adoptedOpenedAt = null;
}
