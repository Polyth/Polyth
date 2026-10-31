// Append-only, space-scoped audit trail (JSONL, one file per day).
//
// Hosted execution needs to answer "who did what, in which Space" after the
// fact. Records carry identifiers only: a secret's HANDLE is auditable, its
// value never is, and payloads are shallow-copied through a filter that drops
// anything that looks like a credential.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject, SpaceAuditEvent, SpaceContext } from "@polyth/contracts";

/** Actions worth an audit row. Free-form strings are accepted too; these are
 *  the ones the platform emits itself. */
export const AUDIT = {
  spaceCreated: "space.created",
  spaceRenamed: "space.renamed",
  spaceDeleted: "space.deleted",
  spaceSwitched: "space.switched",
  memberAdded: "member.added",
  memberRemoved: "member.removed",
  secretResolved: "secret.resolved",
  runnerCreated: "runner.created",
  runnerDestroyed: "runner.destroyed",
  portExposed: "port.exposed",
  packageInstalled: "package.installed",
  integrationChanged: "integration.changed",
  destructiveOperation: "operation.destructive",
} as const;

const SECRETISH = /(secret|token|password|passphrase|apikey|api_key|credential|private_?key|cookie|authorization)/i;

/** Values never leave this filter: a key that reads like a credential is
 *  replaced, and nested objects are filtered recursively. */
export function redact(detail: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SECRETISH.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = redact(value as JsonObject);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export interface AuditSink {
  record(
    ctx: Pick<SpaceContext, "spaceId" | "userId" | "storageDir">,
    action: string,
    opts?: {
      resource?: { kind: string; id: string };
      outcome?: "allowed" | "denied";
      detail?: JsonObject;
    },
  ): void;
}

const day = (time: number): string => new Date(time).toISOString().slice(0, 10);

/** Writes under the Space's own storage root, so an audit trail moves with the
 *  tenant and can never be read through another tenant's storage handle. */
export function createAuditSink(opts: { now?: () => number } = {}): AuditSink {
  const now = opts.now ?? Date.now;
  return {
    record(ctx, action, options = {}) {
      const event: SpaceAuditEvent = {
        time: now(),
        spaceId: ctx.spaceId,
        userId: ctx.userId,
        action,
        ...(options.resource ? { resource: options.resource } : {}),
        outcome: options.outcome ?? "allowed",
        ...(options.detail ? { detail: redact(options.detail) } : {}),
      };
      try {
        const dir = join(ctx.storageDir, "audit");
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, `${day(event.time)}.jsonl`), `${JSON.stringify(event)}\n`);
      } catch (cause) {
        // Auditing must never take a request down; a failure is itself logged.
        console.warn(`[polyth] audit write failed: ${(cause as Error).message}`);
      }
    },
  };
}
