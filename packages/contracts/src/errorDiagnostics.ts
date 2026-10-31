/** Additive HTTP diagnostics. Never contains runtime authority, credentials or payloads. */
export interface ErrorDiagnostics {
  code: string;
  component: "client-transport" | "harness-transport" | "provider" | "storage" | "validation" | "auth" | "server";
  operation: string;
  requestId: string;
  retryability: "never" | "safe" | "after-recovery";
  recovery: "none" | "verifying" | "reconnecting" | "degraded" | "blocked";
  mutationOutcome: "not-applicable" | "not-started" | "confirmed" | "rejected" | "unknown";
}

/** Validate only public fields; old envelopes and future fields remain compatible. */
export function readErrorDiagnostics(value: unknown): Partial<ErrorDiagnostics> {
  if (!value || typeof value !== "object") return {};
  const row = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const key of ["code", "operation", "requestId"] as const) {
    if (typeof row[key] === "string" && row[key].length <= 160) result[key] = row[key];
  }
  const choices = {
    component: ["client-transport", "harness-transport", "provider", "storage", "validation", "auth", "server"],
    retryability: ["never", "safe", "after-recovery"],
    recovery: ["none", "verifying", "reconnecting", "degraded", "blocked"],
    mutationOutcome: ["not-applicable", "not-started", "confirmed", "rejected", "unknown"],
  };
  for (const [key, values] of Object.entries(choices)) {
    if (typeof row[key] === "string" && values.includes(row[key])) result[key] = row[key];
  }
  return result as Partial<ErrorDiagnostics>;
}
