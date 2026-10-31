// Server-only (node:crypto). The canonical session id for one keyed create
// (`clientOperationId`), shared by every create route — ordinary and isolated —
// so a resend on either resolves to the same session and the create-operations
// probe finds both. A one-way digest of (purpose, account, Space, key): the
// client chooses no session id and cannot alias or probe another account's or
// Space's sessions.
import { createHash } from "node:crypto";

export function sessionIdForCreateOperation(
  clientOperationId: string,
  ctx: { readonly userId: string; readonly spaceId: string },
): string {
  const digest = createHash("sha256")
    .update("polyth.session-create\0")
    .update(ctx.userId).update("\0")
    .update(ctx.spaceId).update("\0")
    .update(clientOperationId.toLowerCase())
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const CLIENT_OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validate an optional request-body key; `undefined` when absent. */
export function clientOperationIdInput(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !CLIENT_OPERATION_ID.test(value)) {
    throw Object.assign(new Error("clientOperationId must be a UUID"), { code: "invalid-input" });
  }
  return value.toLowerCase();
}
