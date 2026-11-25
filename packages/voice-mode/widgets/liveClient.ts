// Tells the server that this person hears a conversation's replies read aloud
// (`src/liveRoutes.ts`), so the agent answers in spoken style. Best effort: a
// failed call only means the agent writes as usual.
import type { VoiceLiveRequest } from "../src/liveRoutes.ts";

export function announceVoiceLive(request: VoiceLiveRequest): void {
  if (typeof fetch !== "function") return;
  void fetch("/api/voice-mode/live", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    // Ending voice mode by closing the tab must still reach the server.
    keepalive: true,
  }).catch(() => {});
}
