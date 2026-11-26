import { readErrorDiagnostics, type ErrorDiagnostics } from "@polyth/contracts";
import { EDITION_UNAVAILABLE_CODE } from "@polyth/contracts/edition";

// Refusals the router answers before any effect (404/409/413/501, can't-start 503):
// nothing was applied, so the caller is not in doubt. Any other untagged mutation
// failure stays `unknown`. `ENOENT` is deliberately absent: a raw fs error can land
// after an earlier step already wrote.
const REFUSED = new Set([
  "not-found", "conflict", "draft-conflict", "history-mismatch", "catalog-changed", "worktree-dirty",
  // Git refused a branch change before touching anything (packages/git classifyGitRefusal).
  "branch-in-use", "branch-exists", "branch-not-found", "invalid-branch-name", "session-busy",
  "payload-too-large", "unsupported", "capability-unsupported",
  "runtime-unavailable", "backend-not-ready", "discovery-unavailable", "memory-required",
  // The runtime fence refuses before any effect: a retry is safe.
  "restart-deferred", "shutting_down",
  // An owner-set daily limit refuses before anything is sent or created.
  "limit-reached",
  // The running edition does not offer the action (an install in the
  // workstation edition): refused before anything starts.
  EDITION_UNAVAILABLE_CODE,
]);

/** A failure of an idempotent lifecycle pass (opening or warming a chat): not
 *  a write the caller made, so nothing waits to be checked before trying
 *  again and it never reports an unknown outcome, whatever it failed on. A
 *  copy keeps a shared (cached) error's own tags intact for its other callers. */
export function lifecyclePassError(error: unknown): unknown {
  if (!error || typeof error !== "object") return error;
  return Object.assign(
    new Error(error instanceof Error ? error.message : String(error), { cause: error }),
    error,
    { mutationOutcome: "not-applicable", retryability: "safe" },
  );
}

export function httpErrorDiagnostics(error: unknown, method: string, requestId: string): ErrorDiagnostics {
  const typed = readErrorDiagnostics(error);
  const code = typed.code ?? "internal";
  const component = typed.component
    ?? (["unauthorized", "forbidden", "auth-rejected", "http-401", "http-403"].includes(code) || code.startsWith("AUTH_") ? "auth"
      : ["storage-unavailable", "ENOSPC", "SQLITE_FULL", "SQLITE_BUSY", "ERR_SQLITE_ERROR"].includes(code) ? "storage"
      : ["invalid-input", "invalid-json", "invalid-path", "invalid-model", "invalid-variant", "validation", "http-400", "http-415", "http-422"].includes(code) ? "validation"
      : ["harness-transport", "runtime-unresponsive"].includes(code) ? "harness-transport"
      : code === "invalid-response" || code === "protocol-response-invalid" || /^http-\d{3}$/.test(code) ? "harness-transport"
      : code === "native-failure" || code === "runtime-rejected" ? "provider" : "server");
  const read = method === "GET" || method === "HEAD";
  const mutationOutcome = typed.mutationOutcome ?? (read ? "not-applicable"
    : component === "auth" || component === "validation" || REFUSED.has(code) ? "not-started" : "unknown");
  return {
    code, component, requestId, operation: typed.operation ?? method,
    retryability: mutationOutcome === "unknown" ? "never" : typed.retryability ?? (read ? "safe" : "never"),
    recovery: typed.recovery ?? "none",
    mutationOutcome,
  };
}
