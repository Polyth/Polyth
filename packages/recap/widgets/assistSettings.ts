import { createApiTransport } from "@polyth/web-sdk";

/** Which suggestion wins the composer chip when the harness offers its own
 * (Claude Code) and Session Assist has one too. */
export type SuggestionPriority = "harness" | "assist";

/** Browser copy of `/api/settings/assist`, shared by the settings page and the
 * composer widget so a toggle there applies here without a reload. */
export interface AssistSettings {
  idleSeconds: number;
  suggestNextPrompt: boolean;
  suggestionPriority: SuggestionPriority;
  showCallouts: boolean;
}

const api = createApiTransport();
const listeners = new Set<() => void>();
let current: AssistSettings | null = null;
let loading: Promise<AssistSettings> | null = null;

export function assistSettings(): AssistSettings | null {
  return current;
}

export function subscribeAssistSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function rememberAssistSettings(next: Partial<AssistSettings> & { idleSeconds: number }): void {
  current = {
    idleSeconds: next.idleSeconds,
    suggestNextPrompt: next.suggestNextPrompt !== false,
    suggestionPriority: next.suggestionPriority === "assist" ? "assist" : "harness",
    showCallouts: next.showCallouts === true,
  };
  for (const listener of [...listeners]) listener();
}

/** Test seam: back to a fresh page that has not loaded the settings yet. */
export function forgetAssistSettings(): void {
  current = null;
  loading = null;
  for (const listener of [...listeners]) listener();
}

/** One request per page load; a failure leaves the setting unknown (no
 * automatic suggestions) and the next call asks again — the composer's source
 * calls this on every conversation movement until it succeeds. */
export function loadAssistSettings(): Promise<AssistSettings> {
  loading ??= api.get<AssistSettings>("/api/settings/assist")
    .then((next) => { rememberAssistSettings(next); return current!; })
    .catch((error: unknown) => { loading = null; throw error; });
  return loading;
}
