// Attachment tiles show the full-size file, and a browser gives one HTTP/1.1
// origin six sockets. Left alone, a chat's photos take all six for as long as
// they download, and everything else on the page waits behind them: the history
// of the chat the person just tapped, and even the phone's local draft read. So
// tiles load a couple at a time and the rest of the page keeps its sockets.

/** Tiles downloading at once. The remaining sockets stay free for the app. */
export const MAX_THUMB_LOADS = 2;
/** A dropped transfer (Polyth Link replacing a connection) is worth another try:
 *  an `<img>` never retries by itself and the tile would stay broken. */
export const THUMB_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 12_000];

export interface ThumbQueue {
  /** Calls `grant` once a slot is free. The result gives the slot back, or
   *  leaves the line if none was granted yet; calling it again does nothing. */
  request(grant: () => void): () => void;
}

export function createThumbQueue(limit = MAX_THUMB_LOADS): ThumbQueue {
  let active = 0;
  const waiting: Array<() => void> = [];
  const admit = (): void => {
    while (active < limit && waiting.length > 0) {
      active += 1;
      waiting.shift()!();
    }
  };
  return {
    request(grant) {
      let state: "waiting" | "granted" | "released" = "waiting";
      const entry = (): void => {
        state = "granted";
        grant();
      };
      waiting.push(entry);
      admit();
      return () => {
        if (state === "released") return;
        if (state === "waiting") waiting.splice(waiting.indexOf(entry), 1);
        else active -= 1;
        state = "released";
        admit();
      };
    },
  };
}

/** One line for the page: every chat and composer shares the same sockets. */
export const thumbQueue = createThumbQueue();
