// The browser side of the small-model narrator: one request per remark,
// bounded in time. Every outcome is something the controller can act on;
// nothing here throws.
import type { NarrateRequest, NarrationStatus } from "../src/narrateRoutes.ts";

export type NarrateOutcome =
  | { kind: "text"; text: string }
  /** No small model (or no direct completion, or no grant here): stop asking. */
  | { kind: "unconfigured" }
  /** The server's rate limit: say this remark from the phrases, keep asking. */
  | { kind: "limited" }
  | { kind: "failed" };

const CLIENT_TIMEOUT_MS = 8_000;

export async function requestNarration(request: NarrateRequest, signal: AbortSignal): Promise<NarrateOutcome> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, CLIENT_TIMEOUT_MS);
  try {
    const response = await fetch("/api/voice-mode/narrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: abort.signal,
    });
    if (response.status === 429) return { kind: "limited" };
    if (response.status === 503 || response.status === 403 || response.status === 404) return { kind: "unconfigured" };
    if (!response.ok) return { kind: "failed" };
    const body = await response.json().catch(() => ({})) as { text?: unknown };
    return { kind: "text", text: typeof body.text === "string" ? body.text : "" };
  } catch {
    return { kind: "failed" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

/** Whether the account has a small model (Settings shows it); null when unknown. */
export async function loadNarrationStatus(): Promise<NarrationStatus | null> {
  try {
    const response = await fetch("/api/voice-mode/narration");
    if (!response.ok) return null;
    const body = await response.json() as Partial<NarrationStatus>;
    return typeof body.configured === "boolean"
      ? { configured: body.configured, ...(typeof body.label === "string" ? { label: body.label } : {}) }
      : null;
  } catch {
    return null;
  }
}
