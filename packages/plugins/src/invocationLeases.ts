import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  parseContributionCompletion,
  type ContributionCompletion,
  type ContributionInvocation,
  type ContributionInvocationKind,
} from "@polyth/package-sdk";

const DEFAULT_TTL_MS = 30_000;
const MAX_ACTIVE_LEASES = 256;
const MAX_INVOCATION_BYTES = 64 * 1024;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

const tokenKey = (token: string): string => createHash("sha256").update(token).digest("hex");

export interface InvocationLeaseIdentity {
  packageId: string;
  spaceId: string;
  generation: string;
}

interface LeaseRecord extends InvocationLeaseIdentity {
  invocationId: string;
  contributionId: string;
  kind: ContributionInvocationKind;
  sessionId?: string;
  projectId?: string;
  messageId?: string;
  toolCallId?: string;
  expiresAt: number;
}

export interface InvocationLeaseStore {
  issue(identity: InvocationLeaseIdentity, invocation: Omit<ContributionInvocation, "invocationId" | "lease" | "expiresAt" | "spaceId">): ContributionInvocation;
  authorize(input: InvocationLeaseIdentity & { invocationId: string; lease: string }): Readonly<LeaseRecord>;
  complete(identity: InvocationLeaseIdentity, completion: ContributionCompletion): Readonly<LeaseRecord>;
  revokePackage(packageId: string): void;
  size(): number;
}

export function createInvocationLeaseStore(options: {
  now?: () => number;
  ttlMs?: number;
} = {}): InvocationLeaseStore {
  const now = options.now ?? Date.now;
  const ttlMs = Math.min(Math.max(options.ttlMs ?? DEFAULT_TTL_MS, 1_000), 120_000);
  const records = new Map<string, LeaseRecord>();

  const sweep = (): void => {
    const at = now();
    for (const [key, record] of records) if (record.expiresAt <= at) records.delete(key);
  };

  const authorize = (
    input: InvocationLeaseIdentity & { invocationId: string; lease: string },
  ): LeaseRecord => {
    sweep();
    const key = tokenKey(input.lease);
    const record = records.get(key);
    if (!record) fail("INVOCATION_EXPIRED", "extension invocation is expired or no longer active");
    if (record.invocationId !== input.invocationId) fail("INVOCATION_DENIED", "extension invocation does not match");
    if (record.packageId !== input.packageId) fail("INVOCATION_DENIED", "extension invocation belongs to another package");
    if (record.spaceId !== input.spaceId) fail("INVOCATION_DENIED", "extension invocation belongs to another Space");
    if (record.generation !== input.generation) fail("INVOCATION_EXPIRED", "extension invocation belongs to an obsolete package generation");
    if (record.expiresAt <= now()) {
      records.delete(key);
      fail("INVOCATION_EXPIRED", "extension invocation expired");
    }
    return record;
  };

  return {
    issue(identity, invocation) {
      sweep();
      if (records.size >= MAX_ACTIVE_LEASES) fail("HOST_REJECTED", "too many active extension invocations");
      const serialized = JSON.stringify(invocation);
      if (Buffer.byteLength(serialized, "utf8") > MAX_INVOCATION_BYTES) {
        fail("INVALID_REQUEST", "extension invocation exceeds size limit");
      }
      const invocationId = randomUUID();
      const lease = randomBytes(32).toString("base64url");
      const expiresAt = now() + ttlMs;
      const messageId = invocation.kind === "message-action" ? invocation.message.id : undefined;
      const toolCallId = invocation.kind === "tool-renderer" ? invocation.tool.callId : undefined;
      records.set(tokenKey(lease), {
        ...identity,
        invocationId,
        contributionId: invocation.contributionId,
        kind: invocation.kind,
        ...(invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
        ...(invocation.projectId ? { projectId: invocation.projectId } : {}),
        ...(messageId ? { messageId } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        expiresAt,
      });
      return {
        ...invocation,
        invocationId,
        lease,
        expiresAt,
        spaceId: identity.spaceId,
      } as ContributionInvocation;
    },
    authorize,
    complete(identity, completion) {
      const parsed = parseContributionCompletion(completion);
      const record = authorize({
        ...identity,
        invocationId: parsed.invocationId,
        lease: parsed.lease,
      });
      records.delete(tokenKey(parsed.lease));
      return record;
    },
    revokePackage(packageId) {
      for (const [key, record] of records) if (record.packageId === packageId) records.delete(key);
    },
    size() {
      sweep();
      return records.size;
    },
  };
}
