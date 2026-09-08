// Cursor model support is capability-probed through ACP session metadata. Its
// CalVer is cache identity only; it is not a protocol capability contract.
import type { HarnessProbe } from "@polyth/contracts";

/**
 * Whether it is worth asking this Cursor CLI for a model catalog. An
 * unauthenticated agent refuses `session/new`; otherwise the ACP response is
 * the only authority on whether a model catalog exists.
 */
export function cursorModelDiscoverySupport(
  probe: HarnessProbe,
): { ok: true } | { ok: false; reason: string } {
  if (probe.authenticated === false) {
    return { ok: false, reason: "Cursor is not signed in. Run `agent login`, then reopen this menu." };
  }
  return { ok: true };
}
