import { createStore as createCoreStore, type Store } from "./index.ts";
import { queuePausedAfterUserInterrupt } from "./queuePause.ts";

export * from "./index.ts";
export { queuePausedAfterUserInterrupt } from "./queuePause.ts";

const QUEUE_PAUSE_EVENT_WINDOW = 256;

/**
 * Public store factory. Automatic FIFO reservation is suppressed after an
 * explicit user Stop while pre-existing follow-ups remain queued. A later
 * turn/started (including Resume/Steer) clears the derived pause naturally.
 */
export function createStore(dbPath: string): Store {
  const store = createCoreStore(dbPath);
  const reserveQueueHead = store.reserveQueueHead.bind(store);

  store.reserveQueueHead = async (input) => {
    const [events, queued] = await Promise.all([
      store.events(input.sessionId, 0, { limit: QUEUE_PAUSE_EVENT_WINDOW }),
      store.queueList(input.sessionId),
    ]);
    if (queuePausedAfterUserInterrupt(events, queued)) {
      return { kind: "empty" };
    }
    return reserveQueueHead(input);
  };

  return store;
}
