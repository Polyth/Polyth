// Cursor's CLI is versioned CalVer (`YYYY.MM.DD`). Which ACP surface it speaks
// therefore depends on the installed build, not on a capability flag: the
// agent answers `session/set_model` from the generation below onwards, and an
// older build routes no model method at all. Everything else about Cursor's
// integration is generic ACP.
import type { HarnessProbe } from "@polyth/contracts";

/** First Cursor CLI generation verified to route the ACP model API. */
export const CURSOR_MODEL_API_MIN_VERSION = "2026.09.02";

const calver = (value: string | undefined): [number, number, number] | undefined => {
  const match = /(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(value ?? "");
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const atLeast = (version: string | undefined, minimum: string): boolean | undefined => {
  const found = calver(version);
  const floor = calver(minimum);
  if (!found || !floor) return undefined;
  for (let i = 0; i < 3; i++) {
    if (found[i]! !== floor[i]!) return found[i]! > floor[i]!;
  }
  return true;
};

/**
 * Whether it is worth asking this Cursor CLI for a model catalog. An
 * unauthenticated agent refuses `session/new`, and a build older than the
 * model API has nothing to answer with — both are reported as a cause the user
 * can act on rather than an empty list.
 */
export function cursorModelDiscoverySupport(
  probe: HarnessProbe,
): { ok: true } | { ok: false; reason: string } {
  if (probe.authenticated === false) {
    return { ok: false, reason: "Cursor is not signed in. Run `agent login`, then reopen this menu." };
  }
  const supported = atLeast(probe.version, CURSOR_MODEL_API_MIN_VERSION);
  if (supported === false) {
    return {
      ok: false,
      reason: `This Cursor CLI (${probe.version}) does not expose model selection. Update to ${CURSOR_MODEL_API_MIN_VERSION} or newer.`,
    };
  }
  // An unparseable version is not evidence of absence: ask the agent.
  return { ok: true };
}
