// Voice mode runs in one browser tab (or desktop window) at a time: two open
// microphones would both hear — and send — every word. Starting it announces
// this tab; every other tab that hears the announcement ends its own.
const CHANNEL = "polyth.voice-mode";
const STORAGE_KEY = "polyth.voice-mode.tab";

interface ClaimMessage {
  type: "claim";
  tab: string;
}

export interface TabClaim {
  claim(): void;
  onClaimed(listener: () => void): () => void;
  dispose(): void;
}

const isClaim = (value: unknown, self: string): value is ClaimMessage =>
  !!value && typeof value === "object"
  && (value as Partial<ClaimMessage>).type === "claim"
  && typeof (value as Partial<ClaimMessage>).tab === "string"
  && (value as ClaimMessage).tab !== self;

export function createTabClaim(scope: { BroadcastChannel?: typeof BroadcastChannel; localStorage?: Storage } & Pick<Window, "addEventListener" | "removeEventListener">
  | undefined = typeof window !== "undefined" ? window : undefined): TabClaim {
  const tab = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const Channel = scope?.BroadcastChannel;
  const channel = Channel ? new Channel(CHANNEL) : null;
  const onMessage = (event: MessageEvent) => { if (isClaim(event.data, tab)) notify(); };
  // Without BroadcastChannel, a storage write reaches the other tabs.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      if (isClaim(JSON.parse(event.newValue), tab)) notify();
    } catch { /* not ours */ }
  };
  if (channel) channel.addEventListener("message", onMessage);
  else scope?.addEventListener("storage", onStorage as EventListener);
  return {
    claim() {
      const message: ClaimMessage = { type: "claim", tab };
      if (channel) {
        channel.postMessage(message);
        return;
      }
      try {
        scope?.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ ...message, at: Date.now() }));
      } catch { /* private mode: one tab is all we can know about */ }
    },
    onClaimed(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      listeners.clear();
      if (channel) {
        channel.removeEventListener("message", onMessage);
        channel.close();
      } else {
        scope?.removeEventListener("storage", onStorage as EventListener);
      }
    },
  };
}
