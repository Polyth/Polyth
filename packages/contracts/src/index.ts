// Polyth public contracts. Type-only. No implementation imports allowed here.
// Erasable TS only (no enums/namespaces) — Node strips types at runtime.
import type { IncomingMessage, ServerResponse } from "node:http";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

export interface Disposable { dispose(): void | Promise<void> }

/** Server route contribution shared by trusted server plugins and the gateway. */
export type RouteHandler = (request: RouteRequest) => Promise<boolean>;

/** How this process accepted a request. Built by the listener or internal
 *  dispatcher — never parsed from client headers. */
export type RequestIngress =
  | {
      kind: "public-http";
      listenerId: string;
      loopback: boolean;
      secure: boolean;
    }
  | {
      kind: "polyth-link";
      connectionId: string;
      transport: "direct" | "relay";
    }
  | {
      kind: "internal";
      serviceId: string;
    };

/** Immutable caller identity for one request. Private keys and raw secrets
 *  never appear here. */
export type AuthPrincipal =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "local-user";
      readonly sessionId?: string;
      readonly trustedLoopback: true;
    }
  | {
      readonly kind: "ui-session";
      readonly sessionId: string;
      readonly rememberedDeviceId: string;
    }
  | {
      readonly kind: "paired-device";
      readonly deviceId: string;
      readonly deviceEndpointId: string;
      readonly connectionId: string;
      readonly transport: "direct" | "relay";
      readonly grants: readonly string[];
      readonly grantRevision: number;
    }
  | {
      readonly kind: "internal-service";
      readonly serviceId: string;
    };

export interface AuthResolution {
  readonly principal: AuthPrincipal;
  readonly authenticated: boolean;
}

export type AuthScope = AuthPrincipal["kind"];

export interface AuthStatusDto {
  required: boolean;
  authorized: boolean;
  scope: AuthScope;
}

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

/** Package-owned remote HTTP rule. `path` is a deterministic pattern with
 *  optional `:param` segments — not an executable regular expression. */
export interface RemoteHttpRule {
  methods: readonly HttpMethod[];
  path: string;
  capability: string;
  mutation: boolean;
  maxBodyBytes?: number;
}

export interface RemoteWebSocketRule {
  path: string;
  capability: string;
}

export interface RemoteAccessPolicy {
  routeScopes: readonly string[];
  http: readonly RemoteHttpRule[];
  websocket?: readonly RemoteWebSocketRule[];
}

export const REMOTE_PATH_PATTERN = /^(?:\/[A-Za-z0-9._-]+|\/:[A-Za-z][A-Za-z0-9_]*)+$/;

export function isRemotePathPattern(pattern: string): boolean {
  return pattern.length > 0 && pattern.length <= 256 && REMOTE_PATH_PATTERN.test(pattern);
}

/** Reject encoded dots, backslashes, NUL, duplicate separators, and any
 *  percent-encoding: remote paths are matched literally, so an encoded
 *  segment can never mean the same route as its decoded form. */
export function canonicalizeRemotePath(path: string): string | null {
  if (typeof path !== "string" || path.length === 0 || path.length > 2048) return null;
  if (!path.startsWith("/") || path.includes("//") || path.includes("\\") || path.includes("\0")) return null;
  if (path.includes("%")) return null;
  const parts = path.split("/").slice(1);
  for (const part of parts) {
    if (!part || part === "." || part === "..") return null;
    if (!/^[A-Za-z0-9._-]+$/.test(part)) return null;
  }
  return path;
}

export function remotePathPatternsOverlap(left: string, right: string): boolean {
  if (!isRemotePathPattern(left) || !isRemotePathPattern(right)) return false;
  const leftParts = left.split("/").slice(1);
  const rightParts = right.split("/").slice(1);
  if (leftParts.length !== rightParts.length) return false;
  for (let i = 0; i < leftParts.length; i++) {
    const a = leftParts[i]!;
    const b = rightParts[i]!;
    if (a.startsWith(":") || b.startsWith(":")) continue;
    if (a !== b) return false;
  }
  return true;
}

/** Match a declared remote path pattern against a request pathname. */
export function matchRemotePath(pattern: string, path: string): boolean {
  if (!isRemotePathPattern(pattern)) return false;
  const canonical = canonicalizeRemotePath(path);
  if (!canonical) return false;
  const patternParts = pattern.split("/").slice(1);
  const pathParts = canonical.split("/").slice(1);
  if (patternParts.length !== pathParts.length) return false;
  for (let i = 0; i < patternParts.length; i++) {
    const expected = patternParts[i]!;
    const actual = pathParts[i]!;
    if (expected.startsWith(":")) {
      if (!/^[A-Za-z0-9._-]+$/.test(actual)) return false;
      continue;
    }
    if (expected !== actual) return false;
  }
  return true;
}

export interface RouteRequest {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  method: string;
  ingress: RequestIngress;
  principal: AuthPrincipal;
  /** Resolved tenant context: identity + Space + membership role, validated
   *  by the gateway BEFORE any handler runs. Handlers must scope every
   *  resource lookup through it and must never trust a client-supplied
   *  space/tenant id. */
  space: SpaceContext;
  /** Throws and maps to 401/403. Handlers must not continue after this. */
  requireCapability(capability: string): void;
  body(): Promise<Record<string, unknown>>;
  json(code: number, body: unknown): void;
}

/** Internal services that may administer Polyth Link. Empty by default. */
export const LOCAL_TUNNEL_ADMIN_SERVICES: readonly string[] = [];

/** Local loopback administration of pairing, devices, grants, and identity.
 *  Paired devices and anonymous callers are always denied. Internal services
 *  are denied unless their serviceId is explicitly allowlisted. */
export function requireLocalTunnelAdmin(
  request: Pick<RouteRequest, "ingress" | "principal">,
  opts?: { allowInternalServices?: readonly string[] },
): void {
  const principal = request.principal;
  if (principal.kind === "paired-device") {
    throw Object.assign(new Error("not allowed"), { code: "forbidden" });
  }
  if (principal.kind === "anonymous") {
    throw Object.assign(new Error("authentication required"), { code: "unauthorized" });
  }
  if (principal.kind === "internal-service") {
    const allowed = opts?.allowInternalServices ?? LOCAL_TUNNEL_ADMIN_SERVICES;
    if (!allowed.includes(principal.serviceId)) {
      throw Object.assign(new Error("not allowed"), { code: "forbidden" });
    }
    return;
  }
  if (request.ingress.kind !== "public-http" || request.ingress.loopback !== true) {
    throw Object.assign(new Error("not allowed"), { code: "forbidden" });
  }
  if (principal.kind === "local-user" || principal.kind === "ui-session") return;
  throw Object.assign(new Error("not allowed"), { code: "forbidden" });
}

// ---------------------------------------------------------------- tenancy

/** Deployment/security profile. Executor selection, host-filesystem browsing,
 *  and package trust all branch on this ONE value instead of scattered
 *  `if (cloud)` checks. Read once at boot from POLYTH_DEPLOYMENT_PROFILE. */
export type DeploymentProfile =
  /** Desktop/local: one trusted operator, host execution, host browsing. */
  | "local-trusted"
  /** Shared server, trusted humans: spaces isolate data, host execution stays. */
  | "server-trusted"
  /** Hosted: tenants are untrusted, execution must be sandboxed. */
  | "multi-tenant-sandboxed";

export const DEPLOYMENT_PROFILES: readonly DeploymentProfile[] = [
  "local-trusted",
  "server-trusted",
  "multi-tenant-sandboxed",
];

export const isDeploymentProfile = (value: unknown): value is DeploymentProfile =>
  typeof value === "string" && (DEPLOYMENT_PROFILES as readonly string[]).includes(value);

/** Host directory browsing (`/api/browse`) exposes the server's filesystem and
 *  is therefore a trusted-deployment affordance only. */
export const allowsHostFilesystemBrowsing = (profile: DeploymentProfile): boolean =>
  profile !== "multi-tenant-sandboxed";

/** Tenant-installed packages may only run in the control plane where every
 *  tenant is already trusted with the host. */
export const allowsTenantPackagesInControlPlane = (profile: DeploymentProfile): boolean =>
  profile === "local-trusted";

/** Interactive OpenCode provider-auth mutations write the host-global
 *  OpenCode credential store. That is honest only when the deployment has
 *  one trusted operator boundary. */
export const allowsInteractiveProviderAuth = (profile: DeploymentProfile): boolean =>
  profile === "local-trusted";

/** Membership role inside one Space. Ordered least → most privileged. */
export type SpaceRole = "viewer" | "member" | "admin" | "owner";

export const SPACE_ROLES: readonly SpaceRole[] = ["viewer", "member", "admin", "owner"];

const SPACE_ROLE_RANK: Record<SpaceRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export const isSpaceRole = (value: unknown): value is SpaceRole =>
  typeof value === "string" && (SPACE_ROLES as readonly string[]).includes(value);

/** True when `role` is at least as privileged as `required`. */
export const roleAtLeast = (role: SpaceRole, required: SpaceRole): boolean =>
  SPACE_ROLE_RANK[role] >= SPACE_ROLE_RANK[required];

/** A person (or service identity) that can hold memberships. Distinct from
 *  AuthPrincipal: a principal is one authenticated request channel, an
 *  identity is the durable account behind it. */
export interface UserDto {
  id: string;
  /** Display name. Never a credential. */
  name: string;
  createdAt: number;
}

/** A Space is the tenant boundary: the unit that owns projects, sessions,
 *  files, secrets, integrations, and executions. User-facing name is "Space";
 *  `spaceId` is the tenant id everywhere in the server. */
export interface SpaceDto {
  id: string;
  name: string;
  /** Stable url/path-safe identifier. Also the on-disk directory name. */
  slug: string;
  color?: string;
  icon?: string;
  createdAt: number;
  updatedAt: number;
  /** The default space is the fallback selection and cannot be deleted. */
  isDefault: boolean;
}

export interface SpaceMemberDto {
  userId: string;
  spaceId: string;
  role: SpaceRole;
  createdAt: number;
}

/** One Space as seen by the current user, with their own role attached. */
export interface SpaceSummaryDto extends SpaceDto {
  role: SpaceRole;
  memberCount: number;
}

/** `/api/spaces` payload: what the switcher renders. */
export interface SpacesStateDto {
  user: UserDto;
  spaces: SpaceSummaryDto[];
  activeSpaceId: string;
  deployment: DeploymentProfile;
  /** False when the caller may not create more spaces (quota/profile). */
  canCreate: boolean;
}

/** Resolved, validated tenant context for one request, socket, or job.
 *
 * It is only ever CONSTRUCTED by the server after authenticating the identity
 * and checking membership. Receiving one is proof that the check happened —
 * that is why services take it as their first argument instead of a bare
 * `spaceId` string that a client could have supplied. */
export interface SpaceContext {
  readonly spaceId: string;
  readonly spaceSlug: string;
  readonly userId: string;
  readonly role: SpaceRole;
  readonly deployment: DeploymentProfile;
  /** Absolute, canonical, per-space storage root. Never client-derived. */
  readonly storageDir: string;
}

/** Per-Space storage handle handed to packages. A package never sees the
 *  server's data directory: it sees its own directory inside ONE Space and
 *  cannot address another tenant's. `path()` validates against traversal and
 *  symlink escape — it is the only supported way to build a path from
 *  user-influenced input. */
export interface SpaceStorage {
  readonly root: string;
  /** `<space>/packages/<packageId>`, created on demand. */
  packageDir(packageId: string): string;
  /** Validated path inside this Space. Throws `invalid-path` on escape. */
  path(relative: string): string;
}

/** Space-scoped audit record. Values of secrets are NEVER recorded — only the
 *  handle that was resolved. */
export interface SpaceAuditEvent {
  time: number;
  spaceId: string;
  userId: string;
  /** `space.created`, `space.switched`, `secret.resolved`, `runner.created`… */
  action: string;
  /** Type + id of the affected resource, when there is one. */
  resource?: { kind: string; id: string };
  outcome: "allowed" | "denied";
  detail?: JsonObject;
}

// ---------------------------------------------------------------- execution plane

/** What a Space's execution is permitted to do. Distinct from the UI/navigation
 *  `capabilities` concept: this one is enforced by the executor, never the UI.
 *  Phase 1 only records it; Phase 2+ executors enforce it. */
export interface ExecutionPolicy {
  /** `none` | `project-ro` | `project-rw` | `space-rw` | `host-rw`. */
  filesystem: "none" | "project-ro" | "project-rw" | "space-rw" | "host-rw";
  shell: boolean;
  network: {
    internet: boolean;
    /** RFC1918 / link-local / metadata endpoints. Denied for hosted tenants. */
    privateNetworks: boolean;
  };
  browser: boolean;
  /** Secure-Safe handles this execution may resolve — never the values. */
  secrets: readonly string[];
  resources: {
    cpuCores?: number;
    memoryBytes?: number;
    diskBytes?: number;
    processes?: number;
    wallClockMs?: number;
  };
}

/** Where an execution runs. `host` is today's behavior; the rest are the
 *  hardening path and must not require changes to session/project APIs. */
export type ExecutionBackendKind =
  | "host"
  | "container"
  | "sandboxed-container"
  | "microvm"
  | "remote-worker";

/** One unit of disposable compute. A Runner is ephemeral; the Space is the
 *  persistent state it mounts. Never assume runner lifetime == session
 *  lifetime, and never assume the runner can reach the control plane. */
export interface RunnerSpec {
  spaceId: string;
  /** Logical owner (session, workflow run, scheduled job) for recovery. */
  ownerKind: "session" | "workflow" | "schedule" | "adhoc";
  ownerId: string;
  cwd: string;
  /** Additional persistent state to mount (worktrees, project roots). */
  mounts: readonly { source: string; target: string; mode: "ro" | "rw" }[];
  env: Readonly<Record<string, string>>;
  policy: ExecutionPolicy;
}

/** Durable identity of a live runner. Recovery after a server restart MUST
 *  match on spaceId as well as runnerId — never on runnerId alone. */
export interface RunnerHandle {
  runnerId: string;
  spaceId: string;
  backend: ExecutionBackendKind;
  ownerKind: RunnerSpec["ownerKind"];
  ownerId: string;
  state: "starting" | "ready" | "stopping" | "gone";
  createdAt: number;
}

export interface ExecCommand {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

/** The narrow protocol between the control plane and the execution plane.
 *  Everything Polyth wants to run against tenant state goes through this, so a
 *  container/microVM/remote-worker backend can be substituted without touching
 *  session or project APIs. Implementations receive an already-validated
 *  SpaceContext; they never resolve tenancy themselves. */
export interface ExecutionBackend {
  readonly kind: ExecutionBackendKind;
  /** Provision compute for `spec`. May reuse a warm runner. */
  acquire(ctx: SpaceContext, spec: RunnerSpec): Promise<RunnerHandle>;
  exec(ctx: SpaceContext, runner: RunnerHandle, command: ExecCommand): Promise<ExecResult>;
  /** Destroy the runner. Persistent Space state must survive. */
  release(ctx: SpaceContext, runner: RunnerHandle): Promise<void>;
  /** Runners this backend believes it owns — used by restart recovery, which
   *  must re-validate tenant ownership before adopting any of them. */
  list(ctx: SpaceContext): Promise<RunnerHandle[]>;
}

// ---------------------------------------------------------------- capabilities

export interface CapabilityKey<T> {
  readonly id: string;      // e.g. "polyth.sessionPersistence"
  readonly version: string; // semver range supported by consumer
  // phantom: T is carried at type level only
  readonly __t?: T;
}
export const cap = <T>(id: string, version = "1"): CapabilityKey<T> => ({ id, version });

// ---------------------------------------------------------------- session events

export interface SessionEvent<T extends JsonObject = JsonObject> {
  id: string;              // uuid
  sessionId: string;
  seq: number;             // monotonic per session, transactionally allocated
  time: number;            // ms epoch
  type: string;            // "assistant/chunk" etc.
  data: T;
  ignorable?: boolean;     // not part of model history derivation
  surfaceOp?: "append" | "replace";
  sourceEventSeqs?: number[];
  producerPlugin?: string;
  v: 1;
}

/** Protocol-neutral durable events emitted when mutation state becomes
 * externally observable. These events are ignorable canonical facts; the
 * operations table remains authoritative for execution state. */
export const CANONICAL_MUTATION_EVENT_TYPES = [
  "mutation/prepared",
  "mutation/claimed",
  "mutation/confirmed",
  "mutation/rejected",
  "mutation/uncertainty-recorded",
  "mutation/nonapplication-confirmed",
  "mutation/fenced",
] as const;
export type CanonicalMutationEventType = (typeof CANONICAL_MUTATION_EVENT_TYPES)[number];

export const CANONICAL_RECONCILIATION_EVENT_TYPES = [
  "reconciliation/started",
  "reconciliation/completed",
  "reconciliation/blocked",
] as const;
export type CanonicalReconciliationEventType = (typeof CANONICAL_RECONCILIATION_EVENT_TYPES)[number];

// Data payloads for the M1 vocabulary (all must stay JSON-serializable)
export interface CompactionRecoveryMetadata {
  compactionSeq: number;
  goalRestored?: boolean;
  pinnedSourceSeqs?: number[];
}
export interface RuntimeEpochRecoveryMetadata {
  epoch: number;
  markerSeq: number;
  goalRestored?: boolean;
  pinnedSourceSeqs?: number[];
}
export interface UserMessageData {
  text: string;
  attachments?: AttachmentRef[];
  /** Agent handoff prompt shown as a semantic GitHub card, not a user bubble. */
  githubConflictResolution?: boolean;
  /** Model-visible recovery instructions kept separate from the visible bubble. */
  recoveryContext?: string;
  /** Durable dedup key proving this compaction was handled by this turn. */
  compactionRecovery?: CompactionRecoveryMetadata;
  /** Durable proof that a confirmed turn restored one fresh runtime epoch. */
  runtimeEpochRecovery?: RuntimeEpochRecoveryMetadata;
}
export interface GithubConflictResolutionStartedData {
  prNumber: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
}
export interface AssistantChunkData { partId: string; text: string }
export interface AssistantReasoningChunkData { partId: string; text: string }
export interface AssistantMessageData { partId: string; text: string; reasoning?: string; tokens?: TokenUsage; cost?: number }
export interface ToolCallData { callId: string; tool: string; input: JsonObject; partId?: string }
export interface ToolResultData { callId: string; tool: string; output: string; title?: string; metadata?: JsonObject; attachments?: AttachmentRef[]; input?: JsonObject }
export interface ToolErrorData { callId: string; tool: string; error: string }
export interface PermissionPreview { title: string; lines: string[]; risk?: "low" | "medium" | "high" }
export type PermissionScope = "once" | "session" | "project";
export interface PermissionRequestData {
  requestId: string; permission: string; patterns: string[]; metadata?: JsonObject; tool?: string;
  /** Server-generated, secret-redacted preview (optional; old events lack it). */
  preview?: PermissionPreview;
  allowedScopes?: PermissionScope[];
}
export interface PermissionResolvedData { requestId: string; reply: "once" | "always" | "reject"; scope?: "session" | "project" }
export interface QuestionOption { value: string; label: string; description?: string }
export interface QuestionItem {
  id: string;
  title?: string;
  prompt: string;
  type: "single" | "multi" | "text";
  options?: QuestionOption[];
  required?: boolean;
  allowOther?: boolean;
}
export interface QuestionRequestData { requestId: string; questions: JsonObject[] }
export interface SecretRequestData {
  requestId: string;
  handle: string;
  label: string;
  purpose?: string;
  kind?: SecureSafeKind;
  existing?: boolean;
}
export interface SecretResolvedData {
  requestId: string;
  action: "saved" | "dismissed";
  handle?: string;
}
export interface RuntimeEpochIdentity {
  authorityId: string;
  generation: number;
  epoch: number;
}
export interface RuntimeEpochReplacedData {
  old: RuntimeEpochIdentity;
  new: RuntimeEpochIdentity;
  reason: string;
}
export interface RuntimeRequestExpiredData {
  requestId: string;
  epoch: number;
  reason: "runtime-epoch-replaced";
}
/** Ignorable marker written when reconciliation reattaches to the SAME owned
 *  backend session after a Polyth restart interrupted an in-flight turn. The
 *  named `turn-submit` / `turn-steer` operations stay `unknown` (never
 *  auto-resolved), but no longer gate send admission — the warm backend is
 *  proven alive, so a new turn may continue on it. Any reserved queue draft
 *  for those turns is held for review, never re-sent. */
export interface RuntimeRestartRecoveredData {
  authorityId: string;
  generation: number;
  reconciliationOrdinal: number;
  recoveredOperationIds: string[];
}

export interface TurnStartedData { turnId: string; model?: ModelRef; agent?: string }

export type TelemetryQuality = "native" | "derived" | "estimated" | "unknown";
export type FeatureSupport = "native" | "emulated" | "unsupported";
export type AttachmentModality = "image" | "file" | "pdf" | "audio" | "url";
export type RuntimeErrorCode =
  | "rate-limited" | "quota-exhausted" | "overloaded" | "auth-expired"
  | "invalid-attachment"
  /** The provider refused the selected model for this account/plan. Recoverable
   * by picking another model; never by waiting or by silently substituting one. */
  | "model-unavailable"
  | "unsupported" | "unknown";

/**
 * Why a harness's model list looks the way it does. `empty` requires an
 * authoritative answer of zero models; `pending` and `unavailable` must never
 * be collapsed into it, or "still discovering" becomes "has no models".
 */
export type ModelDiscoveryState =
  | { state: "available" }
  | { state: "pending" }
  | { state: "empty" }
  | { state: "unavailable"; reason: string };

/** Product-level rejection vocabulary for a refused turn or refused control.
 *  Adapters, admission and the composer all speak these codes so the user sees
 *  one message per real cause instead of adapter-development prose. */
export type TurnRejectionCode =
  /** The harness/model cannot do this at all. */
  | "unsupported"
  /** The attachment itself is the problem (unreadable, wrong shape, too big). */
  | "invalid-attachment"
  /** The requested model is not in this harness's catalog. */
  | "invalid-model"
  /** The requested reasoning variant is not advertised for this model. */
  | "invalid-variant"
  /** The harness could not be asked what it supports right now. */
  | "discovery-unavailable"
  /** The harness needs a native sign-in before it can answer. */
  | "auth"
  /** The native call was made and failed on the provider side. */
  | "native-failure"
  /** The runtime explicitly refused (already in MutationOutcome use). */
  | "runtime-rejected";

/** Provider capacity failure classification for an error turn/stopped. */
export type RateLimitScope = "rate" | "quota" | "overloaded" | "unknown";

/** What the backend adapter could tell about a provider-limit failure — the
 *  raw hint before the server applies its resume policy. */
export interface RateLimitRetryHint {
  scope: RateLimitScope;
  provider?: string;
  /** Provider-advised wait in seconds, when it could be parsed from the error. */
  retryAfterSec?: number;
  /** Absolute ms epoch when the provider window resets. */
  resetAt?: number;
  /** Default true when omitted; false = never auto-retry. */
  retryable?: boolean;
}

/** Resume guidance the server attaches to an error turn/stopped when the
 *  failure is a provider rate-limit / quota exhaustion. */
export interface RateLimitRetry extends RateLimitRetryHint {
  /** ms epoch when the server will auto-resend the last user message. */
  resumeAt: number;
  /** 1 on the first limit hit for this message, incremented on repeats. */
  attempt: number;
}

export interface TurnStoppedData {
  turnId: string;
  reason: "completed" | "aborted" | "error";
  error?: string;
  code?: RuntimeErrorCode;
  retry?: RateLimitRetry;
}

export interface TurnResumeCancelledData {
  turnId?: string;
  /** "user" cancelled the wait, "model-switch" continued on another model,
   *  "resumed" the scheduled resend fired. */
  reason: "user" | "model-switch" | "resumed";
}
export interface TokenUsage { input: number; output: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }
export interface UsageRecordedData {
  model: ModelRef;
  tokens: TokenUsage;
  cost?: number;
  costSource?: TelemetryQuality;
}
export interface ContextWindowState {
  limitTokens?: number;
  usedTokens?: number;
  remainingTokens?: number;
  fraction?: number;
  source: TelemetryQuality;
  updatedAt: number;
  compaction?: { active?: boolean; lastAt?: number };
  /** Invalidates occupancy when the harness or runtime generation changes. */
  harnessId?: string;
  generation?: number;
}
export interface RuntimeCommandDescriptor {
  id: string;
  name: string;
  description?: string;
  owner: "native";
  harnessId: string;
  acceptsArguments?: boolean;
  argumentHint?: string;
  aliases?: string[];
  availability?: "session" | "runtime" | "static";
  invocation: "raw-native-input";
}
export interface RuntimeAttachmentSupport {
  modalities: Partial<Record<AttachmentModality, FeatureSupport>>;
}

/**
 * What the server knows about the session's live runtime, as the composer
 * consumes it. `attachmentSupport` is the harness level only; the composer
 * intersects it with the next-turn model's capabilities using `remote` and
 * `materializeAvailable` so both sides compute delivery from the same inputs.
 */
export interface RuntimeFeaturesDto {
  capabilities: RuntimeCapabilities;
  commands: RuntimeCommandDescriptor[];
  contextWindow?: ContextWindowState;
  /** Whether the current runtime has produced telemetry, can produce it but
   * has no sample yet, or does not implement it. A reported zero is therefore
   * distinct from missing telemetry. */
  telemetry?: {
    usage: { status: "reported" | "unavailable" | "unsupported" };
    context: { status: "reported" | "unavailable" | "unsupported" };
  };
  attachmentSupport: Partial<Record<AttachmentModality, FeatureSupport>>;
  /** The session's execution root lives on another host. */
  remote: boolean;
  /** Staged uploads can be copied into the execution root. */
  materializeAvailable: boolean;
}
export interface RuntimeCommandSupport {
  discovery: FeatureSupport;
  invoke: "raw-native-input" | "unsupported";
}
export interface GoalAttachedData { objective: string; budgetTokens?: number; maxContinuations?: number }
export interface GoalAuditData { verdict: "keep" | "done" | "stuck"; consecutiveStuck: number; note?: string }
export interface ContextPinnedData { sourceEventSeq: number }
export interface ContextUnpinnedData { sourceEventSeq: number }
export interface SessionCompactedData {
  backendEventId?: string;
}
export interface CompactionPartRecordedData {
  partId: string;
  messageId?: string;
  auto?: boolean;
}
export interface GoalContextRestoredData {
  compactionSeq: number;
  sourceMessageSeq: number;
}
export interface ContextRestoredData {
  compactionSeq: number;
  sourceMessageSeq: number;
  pinnedSourceSeqs: number[];
}
export interface SessionRewoundData {
  /** The reverted user/message seq. That message and its following tail are hidden. */
  atSeq: number;
  restoredText?: string;
}
export interface SessionRewindClearedData {
  /** Seq of the session/rewound marker being resolved. */
  rewindSeq: number;
  /** True when a new send replaces the hidden tail; false/absent means redo. */
  replaced?: boolean;
}

// ---------------------------------------------------------------- fork lineage (UX-MSG-ACTIONS)

/** Editable composer seed carried by a per-message fork marker. Never
 *  model-visible: the target prompt is excluded from the child history and
 *  exists only as this draft until the user sends it. */
export interface ForkDraft {
  text: string;
  attachments?: AttachmentRef[];
}

/** `session/forked` marker payload (ignorable). Legacy whole-session markers
 *  carry only `fromSessionId` (+ optional `atSeq`); per-message forks add the
 *  excluded prompt seq, the copied-through seq, and the draft seed. */
export interface SessionForkedData {
  fromSessionId: string;
  /** Legacy whole-session fork bound: events copied up to and including atSeq. */
  atSeq?: number;
  /** Per-message fork: the excluded source `user/message` seq. */
  sourceAtSeq?: number;
  /** Highest source seq copied into the child prefix (0 = empty prefix). */
  copiedThroughSeq?: number;
  draft?: ForkDraft;
}

/** Typed fork response: the child ref plus the lineage/draft the client
 *  persists before navigating to the child. */
export interface ForkResult extends SessionRef {
  fromSessionId?: string;
  sourceAtSeq?: number;
  draft?: ForkDraft;
}

// ---------------------------------------------------------------- M3 workflows: multirun / fusion / walkthrough

export type MultirunRunStatus = "pending" | "running" | "completed" | "failed";
export interface MultirunRunDto {
  id: string; model?: ModelRef; agent?: string; status: MultirunRunStatus;
  output: string; tokens?: TokenUsage; cost?: number; error?: string;
  /** Wall-clock lifecycle supplied by the runner when available. */
  startedAt?: number; finishedAt?: number;
}
export interface MultirunDto { id: string; prompt: string; runs: MultirunRunDto[]; pickedRunId?: string }

export interface MultirunStartedData { multirunId: string; prompt: string; runs: Array<{ runId: string; model?: ModelRef; agent?: string }> }
export interface MultirunRunProgressData {
  multirunId: string; runId: string; status: MultirunRunStatus; output: string;
  tokens?: TokenUsage; cost?: number; error?: string;
  startedAt?: number; finishedAt?: number;
}
export interface MultirunCompletedData { multirunId: string }
export interface MultirunPickedData { multirunId: string; runId: string }

export type WorkflowPipeMode = "direct" | "ancestors";
export type WorkflowPermissionPolicy = "auto" | "manual";
export type WorkflowNodeStatus = "queued" | "running" | "done" | "error" | "skipped" | "stopped";
export type WorkflowRunStatus = "running" | "done" | "error" | "stopped";

export interface WorkflowNodeDto {
  id: string;
  role: string;
  prompt: string;
  model?: ModelRef;
  agent?: string;
  position?: { x: number; y: number };
}

export interface WorkflowEdgeDto {
  id: string;
  source: string;
  target: string;
}

export interface WorkflowRunOptionsDto {
  pipe?: WorkflowPipeMode;
  permissions?: WorkflowPermissionPolicy;
  maxParallel?: number;
  nodeTimeoutMs?: number;
}

export interface WorkflowDto {
  id: string;
  projectId: string;
  name: string;
  nodes: WorkflowNodeDto[];
  edges: WorkflowEdgeDto[];
  defaults?: WorkflowRunOptionsDto;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRunNodeDto {
  id: string;
  role: string;
  status: WorkflowNodeStatus;
  sessionId?: string;
  model?: ModelRef;
  agent?: string;
  activity?: string;
  prompt?: string;
  output?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkflowRunDto {
  id: string;
  workflowId: string;
  /** Owning project and parent log are included for project-wide monitoring. */
  projectId?: string;
  parentSessionId?: string;
  name: string;
  input: string;
  /** Effective options make an honest full-run retry possible after navigation. */
  options?: Required<WorkflowRunOptionsDto>;
  status: WorkflowRunStatus;
  startedAt: number;
  finishedAt?: number;
  layers: string[][];
  nodes: WorkflowRunNodeDto[];
}

export interface WorkflowRunStartedData {
  runId: string;
  workflowId: string;
  projectId?: string;
  parentSessionId?: string;
  name: string;
  input: string;
  options?: Required<WorkflowRunOptionsDto>;
  startedAt: number;
  layers: string[][];
  nodes: WorkflowRunNodeDto[];
}

export interface WorkflowNodeProgressData {
  runId: string;
  nodeId: string;
  node: WorkflowRunNodeDto;
}

export interface WorkflowRunCompletedData {
  runId: string;
  status: WorkflowRunStatus;
  finishedAt: number;
}

export interface FusionWeightDto { model: string; weight: number }
export interface FusionSourceDto { model: string; answer: string }
export type FusionStatus = "running" | "completed" | "failed";
export interface FusionDto {
  id: string; answer: string; weights: FusionWeightDto[]; disagreements: string[];
  sources: FusionSourceDto[]; status: FusionStatus; error?: string;
}

export interface FusionStartedData { fusionId: string; prompt: string; models: string[] }
export interface FusionCompletedData {
  fusionId: string; status: FusionStatus; answer: string;
  weights: FusionWeightDto[]; disagreements: string[];
  sources: FusionSourceDto[]; error?: string;
}

export type WalkthroughStepStatus = "pending" | "approved" | "rejected";
export interface WalkthroughStepDto { file: string; explanation: string; diff: string; status: WalkthroughStepStatus }

export interface WalkthroughStepApprovedData { stepIndex: number; file: string }
export interface WalkthroughStepRejectedData { stepIndex: number; file: string }

export interface AttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Display/download URL. Required (http/https) for kind "url"; for project
   *  files it is the sanitized raw endpoint and purely presentational. */
  url?: string;
  /** Attachment class; absent means "file" (backward compatible). */
  kind?: "file" | "image" | "range" | "url" | "browser-context";
  /** Project-relative path for file/image/range attachments. */
  path?: string;
  /** 1-based inclusive line range (kind "range" only). */
  range?: [number, number];
  /** Structured browser page/element/area/text context (kind "browser-context"). */
  browserContext?: BrowserContext;
}

export const PROMPT_HISTORY_DEFAULT_LIMIT = 40;
export const PROMPT_HISTORY_MIN_LIMIT = 1;
export const PROMPT_HISTORY_MAX_LIMIT = 200;

export function clampPromptHistoryLimit(value: unknown, fallback = PROMPT_HISTORY_DEFAULT_LIMIT): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(PROMPT_HISTORY_MAX_LIMIT, Math.max(PROMPT_HISTORY_MIN_LIMIT, n));
}

/** Composer prompt-history navigation. `session` is the active conversation;
 *  `space` is every eligible session in the current Space. Legacy stored
 *  `"server"` values mean `space` — there is no cross-Space user history. */
export type PromptHistoryScope = "session" | "space";

export function parsePromptHistoryScope(value: unknown): PromptHistoryScope {
  if (value === "space" || value === "server") return "space";
  return "session";
}

/** One submitted composer payload, oldest-first / newest-last in API responses. */
export interface PromptHistoryEntryDto {
  id: string;
  sessionId: string;
  projectId: string;
  /** Session worktree when the prompt was stored; empty/absent means the project root. */
  worktreePath?: string;
  seq: number;
  time: number;
  text: string;
  attachments: AttachmentRef[];
}

export interface PromptHistoryDto {
  entries: PromptHistoryEntryDto[];
}
export interface ModelRef { providerID: string; modelID: string; variant?: string }
/** Model identity once it crosses a harness boundary. Runtime-local APIs may
 * keep using ModelRef because their harness is already fixed by the runtime. */
export interface HarnessModelRef extends ModelRef { harnessId: string }
export interface HarnessAgentRef { harnessId: string; agent: string }

/** An explicit recovery route.  Supplying `harness` makes the resume use the
 * same safe switch-before-send transaction as a normal submitted turn; an
 * absent harness continues on the current runtime leg. */
export interface ResumeTurnOptions {
  model?: ModelRef;
  harness?: HarnessSelection;
}

/** Browser-local execution choices for a conversation that does not exist
 * yet. The server receives these atomically when the first send materializes
 * the canonical session. */
export interface DraftExecutionConfig {
  harnessSelection: HarnessSelection;
  /** Browser-only intent bit: distinguishes untouched Auto from a user who
   * explicitly chose Auto over a project default. */
  harnessSelectionExplicit?: boolean;
  model?: HarnessModelRef;
  profileId?: string;
  agent?: HarnessAgentRef;
  thinking?: string;
  mode?: string;
  features?: Record<string, boolean>;
}

// Model-visible derivation: these types feed deriveMessages()
export const MODEL_VISIBLE_TYPES = [
  "user/message",
  "assistant/message",
  "tool/call",
  "tool/result",
  "tool/error",
  "question/asked",
  "question/answered",
  "package/attached",
  "package/context",
] as const;

export interface ModelMessage {
  role: "user" | "assistant" | "tool";
  parts: Array<
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "file"; name: string; mime: string; path?: string; url?: string; range?: [number, number] }
    | { type: "tool-call"; callId: string; tool: string; input: JsonObject }
    | { type: "tool-result"; callId: string; tool: string; output: string; isError?: boolean }
  >;
}

// ---------------------------------------------------------------- session service

export interface CreateSessionInput {
  projectId: string;
  harness?: HarnessSelection;
  title?: string;
  model?: ModelRef;
  agent?: string;
  parentId?: string;      // subagent / fork parent
  worktreeId?: string;
  /** absolute path of a git worktree; when set the session's runtime uses it as cwd */
  worktreePath?: string;
  /**
   * Internal seam: isolation allocates this so the managed worktree marker
   * matches the session. HTTP session-create must not accept a client id.
   */
  id?: string;
  /** Immutable isolation origin; persisted on the projection through restarts. */
  isolation?: SessionIsolation;
  /** Existing OpenCode session to adopt rather than create. Internal adapter seam. */
  backendSessionId?: string;
}
export interface SessionRef { id: string }
export interface TurnRef { turnId: string }
export interface UserTurnInput {
  text: string;
  /** Opaque client UUID reused only to recover this exact session admission.
   * The durable operation ledger validates its session, kind, and intent. */
  clientOperationId?: string;
  command?: { id: string; args?: string };
  /** Keep this model-visible prompt out of ordinary user chat bubbles. */
  githubConflictResolution?: boolean;
  /** Model-visible retry/regeneration of an already-visible prompt. The
   * canonical event remains durable for runtime continuity, but chat/prompt
   * recall must not render it as a second user submission. */
  hiddenUserMessage?: boolean;
  /** Accept OpenCode's generated title for this first prompt when the session
   *  still has a placeholder title. The client owns the user preference; the
   *  server owns the append + projection update. */
  autoTitle?: boolean;
  attachments?: AttachmentRef[];
  model?: ModelRef;
  agent?: string;
  /** Optional submit-time route intent. When it differs from the canonical
   * session route, the server completes the safe harness switch before this
   * turn is admitted. Absence preserves the current route. */
  harness?: HarnessSelection;
  /** Active-turn delivery admission; defaults to "normal". */
  delivery?: DeliveryMode;
  /** Atomically reject open questions / deny open permissions of this session before admission. */
  dismissPending?: boolean;
  /** Resolve model/agent/options through a stored agent profile at send time.
   *  A string selects a profile, `null` explicitly clears the session's
   *  stored profile, and an omitted field inherits it. The three are never
   *  conflated (UX-COMPOSER-DISC). */
  agentProfileId?: string | null;
  /** Set by the server's rate-limit auto-resume when it re-sends the last user
   * message. Auto-resumes are hidden repeats in ordinary chat surfaces. */
  autoResume?: boolean;
}

export type SessionStatus =
  | "idle"
  | "working"
  | "waiting"
  | "reconciling"
  | "epoch-pending"
  | "unknown"
  | "finished"
  | "failed"
  | "archived";

/** True while a lifecycle mutation (merge/keep/discard/resolve) must wait. */
export const isolationBlocksUserMutation = (status: SessionStatus): boolean =>
  status === "working"
  || status === "unknown"
  || status === "waiting"
  || status === "reconciling"
  || status === "epoch-pending"
  || status === "archived";

/** Derived unresolved-request counters; always computed from durable events. */
export interface SessionAttention {
  questions: number;
  permissions: number;
  unread: number;
  goalStatus?: string;
}

export type BackgroundWorkKind = "multirun" | "fusion";
export interface BackgroundWorkState {
  multirun?: number;
  fusion?: number;
  /** Earliest still-active background workflow. */
  startedAt?: number;
  /** Latest terminal workflow, used for replay-deduped completion notices. */
  lastResult?: {
    id: string;
    kind: BackgroundWorkKind;
    status: "completed" | "failed";
    at: number;
  };
}

export type WorktreeState = "ready" | "bootstrapping" | "busy" | "missing";

/** Isolation lifecycle is independent of agent runtime status (`idle`/`working`). */
export type IsolationState =
  | "active"
  | "merge-ready"
  | "merging"
  | "publishing"
  | "conflict"
  | "rebind-pending"
  | "cleanup-pending"
  | "missing"
  | "unowned"
  | "corrupt";

/**
 * Durable publication intent. Persisted BEFORE the irreversible target-ref
 * update so restart can tell "not published" from "already published".
 */
export interface IsolationPublishIntent {
  expectedTargetSha: string;
  resultCommit: string;
  snapshotSha: string;
  targetRef: string;
  /** Atomic Git receipt fields written by the earlier lifecycle implementation. */
  receiptRef?: string;
  checkoutPath?: string;
  sourceRevision?: string;
}

/**
 * Session isolation origin. The current backend is a managed Git worktree;
 * `kind` keeps the session-level concept open for later backends.
 *
 * `sourceSessionId` is lineage of the session that requested isolation.
 * `targetPath` is the repository root, `targetBranch` is the local branch,
 * `originPath` is the concrete checkout merge-back returns to, and
 * `baseCommit` is ancestry. Isolation is only created when `targetBranch`
 * is checked out somewhere; the session never claims that branch while
 * running in a different workspace.
 */
export interface SessionIsolationIdentity {
  kind: "git-worktree";
  createdAt: string;
  worktreePath: string;
  worktreeBranch: string;
  targetPath: string;
  targetBranch: string;
  /** Immutable checkout identity. Restore this checkout before recovery. */
  originPath?: string;
  baseCommit: string;
  sourceSessionId?: string;
}

/** Backward-compatible name retained for public consumers. */
export type IsolationOrigin = SessionIsolationIdentity;

/** State-specific durable payload. Optional `never` fields keep property reads
 * ergonomic while rejecting contradictory new writes at compile time. */
export type IsolationLifecycle =
  | {
      state: "active" | "merge-ready" | "missing" | "unowned" | "corrupt";
      /** Fingerprint of HEAD + dirty tree when the user chose Keep isolated. */
      dismissedRevision?: string;
      conflict?: never;
      publish?: never;
      resultCommit?: never;
      sourceSnapshotSha?: never;
    }
  | {
      state: "conflict";
      conflict: { message: string; files: string[] };
      dismissedRevision?: never;
      publish?: never;
      resultCommit?: never;
      sourceSnapshotSha?: never;
    }
  | {
      /** Legacy name normalized to `publishing` on read. */
      state: "merging";
      /** Persisted before the irreversible target-ref update. */
      publish: IsolationPublishIntent;
      dismissedRevision?: never;
      conflict?: never;
      resultCommit?: never;
      sourceSnapshotSha?: never;
    }
  | {
      /** Canonical state persisted before the irreversible target-ref update. */
      state: "publishing";
      publish: IsolationPublishIntent;
      dismissedRevision?: never;
      conflict?: never;
      resultCommit?: never;
      sourceSnapshotSha?: never;
      sourceRevision?: never;
      rebound?: never;
    }
  | {
      state: "rebind-pending" | "cleanup-pending";
      /** Published commit SHA; absent for discard cleanup. */
      resultCommit?: string;
      /** Exact source snapshot integrated before publication. */
      sourceSnapshotSha?: string;
      /** Legacy fingerprint retained so an in-flight record remains recoverable. */
      sourceRevision?: string;
      /** `false` is a legacy rebind-pending encoding; cleanup may omit it. */
      rebound?: true;
      dismissedRevision?: never;
      conflict?: never;
      publish?: never;
    }
;

export type SessionIsolation = SessionIsolationIdentity & IsolationLifecycle;

/** Replacing a lifecycle always strips payload owned by the previous phase. */
export function transitionIsolation(
  isolation: SessionIsolationIdentity,
  phase: IsolationLifecycle,
): SessionIsolation {
  const raw = isolation as unknown as SessionIsolationIdentity & Record<string, unknown>;
  const {
    state: _state,
    conflict: _conflict,
    publish: _publish,
    resultCommit: _result,
    sourceSnapshotSha: _snapshot,
    sourceRevision: _revision,
    rebound: _rebound,
    dismissedRevision: _dismissed,
    ...identity
  } = raw;
  return { ...identity, ...phase } as SessionIsolation;
}

/** Normalize legacy records without mutating their input; malformed data fails closed. */
export function normalizeIsolation(value: SessionIsolation): SessionIsolation {
  const raw = value as unknown as SessionIsolationIdentity & Record<string, unknown>;
  const corrupt = () => transitionIsolation(value, { state: "corrupt" });
  const commit = (part: unknown): part is string =>
    typeof part === "string" && /^[0-9a-f]{40,64}$/i.test(part);
  if (![raw.createdAt, raw.worktreePath, raw.worktreeBranch, raw.targetPath, raw.targetBranch, raw.baseCommit]
    .every((part) => typeof part === "string" && part.length > 0)) return corrupt();
  if (raw.originPath !== undefined && typeof raw.originPath !== "string") return corrupt();
  if (raw.sourceSessionId !== undefined && typeof raw.sourceSessionId !== "string") return corrupt();
  const state = raw.state;
  // The original implementation persisted `merging` before it had any
  // irreversible intent. Restarting that exact legacy shape is safely active.
  if (state === "merging" && raw.publish === undefined) {
    if (raw.resultCommit !== undefined || raw.sourceSnapshotSha !== undefined
      || raw.sourceRevision !== undefined) return corrupt();
    return transitionIsolation(value, { state: "active" });
  }
  if (state === "merging" || state === "publishing") {
    const intent = raw.publish as Partial<IsolationPublishIntent> | undefined;
    if (!intent || ![intent.expectedTargetSha, intent.resultCommit, intent.snapshotSha].every(commit)
      || typeof intent.targetRef !== "string"
      || intent.targetRef !== `refs/heads/${String(raw.targetBranch).replace(/^refs\/heads\//, "")}`) return corrupt();
    const receiptFields = [intent.receiptRef, intent.checkoutPath, intent.sourceRevision];
    if (receiptFields.some((part) => part !== undefined)
      && !receiptFields.every((part) => typeof part === "string" && part.length > 0)) return corrupt();
    if (intent.receiptRef !== undefined && !intent.receiptRef.startsWith("refs/polyth/isolation/")) return corrupt();
    return transitionIsolation(value, { state: "publishing", publish: intent as IsolationPublishIntent });
  }
  if (state === "conflict") {
    if (raw.publish !== undefined || raw.resultCommit !== undefined || raw.sourceSnapshotSha !== undefined
      || raw.sourceRevision !== undefined || raw.rebound !== undefined || raw.dismissedRevision !== undefined) return corrupt();
    const conflict = raw.conflict as { message?: unknown; files?: unknown } | undefined;
    if (!conflict || typeof conflict.message !== "string" || !Array.isArray(conflict.files)
      || !conflict.files.every((file) => typeof file === "string")) return corrupt();
    return transitionIsolation(value, { state: "conflict", conflict: { message: conflict.message, files: conflict.files as string[] } });
  }
  if (state === "rebind-pending" || state === "cleanup-pending") {
    if (raw.publish !== undefined || raw.conflict !== undefined || raw.dismissedRevision !== undefined) return corrupt();
    if (raw.sourceRevision !== undefined && typeof raw.sourceRevision !== "string") return corrupt();
    if (raw.resultCommit !== undefined && !commit(raw.resultCommit)) return corrupt();
    if (raw.sourceSnapshotSha !== undefined && !commit(raw.sourceSnapshotSha)) return corrupt();
    if (state === "rebind-pending" && raw.rebound !== undefined) return corrupt();
    if (state === "cleanup-pending" && raw.rebound !== undefined
      && raw.rebound !== true && raw.rebound !== false) return corrupt();
    const nextState = state === "cleanup-pending" && raw.rebound === false ? "rebind-pending" : state;
    return transitionIsolation(value, {
      state: nextState,
      ...(typeof raw.resultCommit === "string" ? { resultCommit: raw.resultCommit } : {}),
      ...(typeof raw.sourceSnapshotSha === "string" ? { sourceSnapshotSha: raw.sourceSnapshotSha } : {}),
      ...(typeof raw.sourceRevision === "string" ? { sourceRevision: raw.sourceRevision } : {}),
      ...(nextState === "cleanup-pending" && raw.rebound === true ? { rebound: true as const } : {}),
    });
  }
  if (["active", "merge-ready", "missing", "unowned", "corrupt"].includes(String(state))) {
    if (raw.conflict !== undefined || raw.publish !== undefined || raw.resultCommit !== undefined
      || raw.rebound !== undefined || raw.sourceRevision !== undefined || raw.sourceSnapshotSha !== undefined
      || raw.dismissedRevision !== undefined && typeof raw.dismissedRevision !== "string") return corrupt();
    return transitionIsolation(value, {
      state: state as "active" | "merge-ready" | "missing" | "unowned" | "corrupt",
      ...(typeof raw.dismissedRevision === "string" ? { dismissedRevision: raw.dismissedRevision } : {}),
    });
  }
  return corrupt();
}

export const isManagedIsolationBranch = (branch?: string | null): boolean =>
  !!branch && /^polyth\/(isolate|integrate)\//.test(branch.replace(/^refs\/heads\//, ""));

export const isolationNeedsRecovery = (state: IsolationState): boolean =>
  state === "merging" || state === "publishing" || state === "rebind-pending" || state === "cleanup-pending";

export function isolationActions(status: IsolationStatusDto, sessionStatus?: SessionStatus) {
  const state = status.effectiveState ?? status.isolation?.state;
  const blocked = !!sessionStatus && isolationBlocksUserMutation(sessionStatus);
  const active = state === "active" || state === "merge-ready" || state === "conflict";
  return {
    canReview: active,
    // `targetDirty` is informational: Git carries compatible local work
    // forward. Keep honoring the legacy blocking reason for older servers.
    canMerge: active && !blocked && status.suggestion?.hasChanges === true
      && status.suggestion.reason !== "dirty-target"
      && status.suggestion.reason !== "destination-unavailable",
    canKeep: active && !blocked,
    canResolve: state === "conflict" && !blocked && status.suggestion?.reason !== "destination-unavailable",
    canDiscard: (active || state === "missing") && !blocked && status.suggestion?.reason !== "destination-unavailable",
    needsRecovery: !!state && !blocked && (isolationNeedsRecovery(state) || state === "missing" || state === "unowned" || state === "corrupt"),
  };
}

export interface CreateIsolatedSessionInput {
  projectId: string;
  harness?: HarnessSelection;
  title?: string;
  model?: ModelRef;
  agent?: string;
  sourceSessionId?: string;
  /** Local branch that is currently checked out; merge-back returns to that workspace. */
  targetBranch?: string;
}

export interface IsolationSuggestionDto {
  eligible: boolean;
  hasChanges: boolean;
  targetBranch: string;
  targetDirty: boolean;
  revision: string;
  reason?:
    | "not-isolated"
    | "working"
    | "no-turn"
    | "no-changes"
    | "dismissed"
    | "conflict"
    | "dirty-target"
    | "missing"
    | "unowned"
    | "corrupt"
    | "destination-unavailable"
    | "merging";
}

export interface IsolationStatusDto {
  isolation: SessionIsolation | null;
  suggestion: IsolationSuggestionDto | null;
  /** Derived from Git + persisted isolation without writing. */
  effectiveState?: IsolationState | null;
  actions?: {
    canReview: boolean;
    canMerge: boolean;
    canKeep: boolean;
    canResolve: boolean;
    canDiscard: boolean;
    canRecover: boolean;
    canAbandon: boolean;
  };
}

export interface IsolationMergeResultDto {
  ok: true;
  commit: string;
  targetBranch: string;
  session: SessionProjection;
  /** False when Git published but rebind/cleanup still needs recovery. */
  finalized: boolean;
}

export function isGitWorktreeIsolation(
  value: SessionIsolation | null | undefined,
): value is SessionIsolation {
  return !!value && value.kind === "git-worktree";
}

/** F9 idle assist: recap + one suggested follow-up, keyed to the log tail.
 *  Projection-only — it is never model-visible unless the user sends it. */
export interface SessionAssist {
  recap: string;
  /** Absent when there is no grounded follow-up — a finished task, a closed
   *  conversation. "No suggestion" is a legitimate result, so it is modelled
   *  as an absent field rather than an empty call to action. */
  suggestion?: string;
  /** Raw log seq the assist settled against; only newer conversation activity makes it stale. */
  atSeq: number;
  generatedAt: number;
}

/** Server-owned pending resume after a provider rate-limit / quota stop. */
export interface SessionResumeState {
  /** ms epoch when the last user message is auto-resent. */
  resumeAt: number;
  scope: RateLimitScope;
  provider?: string;
  /** Provider-advised wait in seconds, when the error carried one. */
  retryAfterSec?: number;
  /** Absolute ms epoch when the provider window resets. */
  resetAt?: number;
  /** 1 on the first limit hit for this message, incremented on repeats. */
  attempt: number;
  /** seq of the user/message that will be re-sent. */
  userMessageSeq: number;
}

export interface SessionProjection {
  id: string; projectId: string; parentId?: string;
  /** Absence on legacy sessions is migrated to Auto with the bundled harness. */
  harness?: HarnessSelection;
  resolvedHarnessId?: string;
  runtimeLeg?: RuntimeLeg;
  harnessTransition?: HarnessTransition;
  /** Owning Space, denormalized from the project so listing/broadcast filters
   *  never need a project join. Backfilled by session-store migration v10. */
  spaceId?: string;
  title: string;
  /** How the current title was chosen; O(1) precedence without log scans. */
  titleSource?: "manual" | "native" | "polyth" | "placeholder";
  status: SessionStatus;
  model?: ModelRef; agent?: string;
  createdAt: number; updatedAt: number;
  lastTurnAt?: number; tokenTotals?: TokenUsage; costTotal?: number;
  /** Live context occupancy from runtime telemetry; never inferred from tokenTotals. */
  contextWindow?: ContextWindowState;
  /** Bumps when the in-memory native command catalog changes. */
  nativeCommandsRevision?: number;
  worktreePath?: string;
  /** Isolation lifecycle; independent of `status`. */
  isolation?: SessionIsolation;
  backendSessionId?: string;
  /** Durable identity of the endpoint generation that owns backendSessionId.
   * A generation-only binding may not be silently carried to a replacement. */
  runtimeBinding?: PersistedRuntimeBinding;
  /** Presentation-only endpoint control for epoch-pending chrome.
   * Not an identity field and not stored on PersistedRuntimeBinding. */
  runtimeControl?: "owned" | "borrowed";
  /** Highest canonical event sequence whose runtime-derived projection effects
   * were applied. Makes post-ingestion projection repair idempotent. */
  runtimeObservationSeq?: number;
  goal?: { objective: string; status: string };
  // -- optional parity metadata (backward compatible: absent on old records) --
  attention?: SessionAttention;
  labelIds?: string[];
  folderId?: string;
  branch?: string;
  worktreeId?: string;
  worktreeState?: WorktreeState;
  agentProfileId?: string;
  /** Organization metadata, never written to the session event log. */
  pinned?: { position: number };
  /** Durable navigation/notification state for workflows that outlive a view. */
  backgroundWork?: BackgroundWorkState;
  /** Small-model idle assist (F9); stale once the log grows past atSeq. */
  assist?: SessionAssist;
  /** Pending auto-resume after a provider rate-limit / quota stop. The server
   *  owns the timer and re-sends the last user message at resumeAt; the UI
   *  shows a countdown with cancel / switch-model actions. Cleared when the
   *  resend starts, the user cancels, or any newer turn begins. */
  resume?: SessionResumeState;
  /** F18: effective auto-accept policy (own setting or nearest parent's) —
   *  drives the loud header indicator. Never a global default. */
  autoAccept?: boolean;
  /** Explicit durable choice owned by this canonical session. Absent means
   *  inherit, preserving projections written before this field existed. */
  autoAcceptSetting?: "on" | "off";
  /** Per-session composer draft text, persisted server-side so it syncs
   *  across clients. Cleared on send. */
  draft?: string;
  /** Timestamp (ms) of the last authoritative draft write; clients use it as
   * a compare-and-set witness and preserve unordered local/server variants. */
  draftUpdatedAt?: number;
}

/** F18: per-session auto-accept policy. "inherit" (the default) walks to the
 *  nearest ancestor with an explicit setting; the root default is off.
 *  "off" on a child is the explicit opt-out from an inherited "on". */
export type AutoAcceptSetting = "on" | "off" | "inherit";

export interface AutoAcceptDto {
  setting: AutoAcceptSetting;
  effective: boolean;
}

/** Persisted binding snapshot for session debug. Identity hashes only — no
 * prompts, tokens, or provider credentials. */
export interface SessionDebugRuntimeBindingDto {
  authorityId: string;
  generation: number;
  epoch: number;
  continuity: "verified" | "generation-only";
  protocol: "legacy" | "v2";
  location: RuntimeLocation;
  historyBaseline?: "empty" | "copied" | "import";
}

/** Attached-endpoint snapshot for session debug. Never includes URL,
 * authentication values, or instance tokens. */
export interface SessionDebugEndpointDto {
  authorityId: string;
  generation: number;
  control: { kind: "owned" | "borrowed"; source?: "shared" | "external" };
}

export interface SessionDebugEpochReplacedDto {
  reason: string;
  old: RuntimeEpochIdentity;
  new: RuntimeEpochIdentity;
  seq: number;
}

/** Computed recovery-plan stats. Never includes recoveryContext text. */
export interface SessionDebugRecoveryPlanDto {
  epoch: number;
  markerSeq: number;
  omittedMessages: number;
  omittedPins: number;
  omittedKnowledge: number;
  omittedSummaries: number;
  sectionsCapped: string[];
  sectionChars: {
    intent: number;
    durable: number;
    summaries: number;
    dialogue: number;
  };
  goalRestored: boolean;
  restored: boolean;
}

/** Durable + live diagnostics exposed to authenticated agent clients. Secret
 * values are never present: pending requests contain opaque ids only. */
export interface SessionDebugDto {
  status: SessionStatus;
  eventCount: number;
  latestSeq: number;
  lastEvent?: { seq: number; time: number; type: string };
  runtime: {
    attached: boolean;
    activeTurn: boolean;
    admissionPending: boolean;
    turnId?: string;
    backendSessionId?: string;
    worktreePath?: string;
  };
  queue: QueueItemDto[];
  pending: {
    permissions: string[];
    questions: string[];
    secrets: string[];
  };
  recentErrors: Array<{ seq: number; time: number; type: string; message: string }>;
  runtimeBinding?: SessionDebugRuntimeBindingDto;
  endpoint?: SessionDebugEndpointDto;
  counts: {
    fencedOperations: number;
    unknownOperations: number;
    heldForReview: number;
  };
  lastEpochReplaced?: SessionDebugEpochReplacedDto;
  recoveryPlan?: SessionDebugRecoveryPlanDto;
}

export interface SessionService {
  switchHarness?(sessionId: string, selection: HarnessSelection, timing?: "after-turn" | "stop-now"): Promise<SessionProjection>;
  /** Cancel is valid only while the previous runtime still owns authority. */
  cancelHarnessSwitch?(sessionId: string): Promise<SessionProjection>;
  create(input: CreateSessionInput): Promise<SessionRef>;
  /** Result carries turnId for admitted turns or queueId+queued for deferred delivery. */
  send(sessionId: string, input: UserTurnInput): Promise<SendResult>;
  /** Read-only recovery view for one account-scoped client admission token.
   * It projects the existing durable operation/queue authorities. */
  clientMutationStatus?(sessionId: string, clientOperationId: string): Promise<ClientMutationStatusDto>;
  abort(sessionId: string, options?: { source?: string }): Promise<void>;
  /** Request native context compaction when the active runtime supports it. */
  compact?(sessionId: string): Promise<void>;
  /** Drop a pending rate-limit auto-resume (projection.resume). No-op when
   *  nothing is scheduled. */
  cancelResume?(sessionId: string): Promise<void>;
  /** Run the pending rate-limit resume immediately: re-send the last user
   *  message now, optionally choosing its model and/or safe harness route.
   *  A bare ModelRef remains accepted for older callers. Rejects `no-resume`
   *  when nothing is scheduled. */
  resumeNow?(sessionId: string, options?: ResumeTurnOptions | ModelRef): Promise<SendResult>;
  /** No atSeq: copy the complete effective history. With atSeq: per-message
   *  fork — the child prefix ends strictly BEFORE the target user message and
   *  the excluded prompt returns as an editable draft. */
  fork(sessionId: string, atSeq?: number): Promise<ForkResult>;
  /** Soft-rewind to a user message without mutating prior events. */
  rewind?(sessionId: string, atSeq: number): Promise<SessionEvent>;
  /** Restore the tail hidden by the active rewind marker. */
  clearRewind?(sessionId: string): Promise<SessionEvent>;
  /** Execute a composer `!` command through the shell permission family. */
  runShell?(sessionId: string, command: string): Promise<ShellTurnResult>;
  archive(sessionId: string): Promise<void>;
  restore(sessionId: string): Promise<void>;
  /** Hard-delete the session (durable log + projection + queue) and any
   *  package-owned isolation resources. Callers confirm destructive intent
   *  upstream. An already-absent workspace needs no runtime rebind; a present
   *  workspace is removed only after exact ownership is proven and any
   *  execution bound to it has verified release. Uncertain upstream identity
   *  remains fenced by the durable
   *  deletion tombstone. Optional so existing fakes/tests remain valid. */
  delete?(sessionId: string): Promise<void>;
  list(projectId?: string): Promise<SessionProjection[]>;
  sync(projectId: string): Promise<SessionProjection[]>;
  snapshot(sessionId: string): Promise<SessionProjection>;
  /** Live runtime feature surface for composer/settings diagnostics. */
  runtimeFeatures?(sessionId: string): Promise<RuntimeFeaturesDto>;
  /** `page` (beforeSeq/limit) selects the newest events in the window so deep
   *  logs hydrate incrementally; implementations may ignore it. */
  events(sessionId: string, afterSeq?: number, page?: EventPage): Promise<SessionEvent[]>;
  /** Read-only troubleshooting state. Does not attach or wake a runtime. */
  debug?(sessionId: string): Promise<SessionDebugDto>;
  replyPermission(sessionId: string, requestId: string, reply: "once" | "always" | "reject", scope?: "session" | "project"): Promise<void>;
  replyQuestion(sessionId: string, requestId: string, answers: JsonObject): Promise<void>;
  replySecret?(sessionId: string, requestId: string, reply: { action: "save"; value: string } | { action: "dismiss" }): Promise<void>;
  // -- parity additions (optional so existing fakes/tests remain valid) --
  /** Append session/metadata-changed and update the projection title. */
  rename?(sessionId: string, title: string): Promise<void>;
  /** Folder/label assignment; folder must belong to the session's project. */
  organize?(sessionId: string, patch: SessionOrganizePatch): Promise<void>;
  /** Projection-only reconciliation after a linked worktree is removed. */
  markWorktreeMissing?(projectId: string, worktreePath: string): Promise<void>;
  /** Record a verified in-place branch rename without resetting the runtime:
   * the checkout path and execution authority are unchanged. */
  renameWorktreeBranch?(sessionId: string, input: {
    worktreePath: string;
    from: string;
    to: string;
  }): Promise<SessionProjection>;
  /** Persist isolation metadata without changing runtime cwd. */
  patchIsolation?(sessionId: string, isolation: SessionIsolation | null): Promise<SessionProjection>;
  /**
   * Move the same session onto a different workspace (after merge/discard).
   * Stops session-local processes tied to the previous cwd and starts a fresh
   * backend epoch in the new cwd so history survives the transition.
   */
  rebindWorkspace?(sessionId: string, input: {
    worktreePath?: string | null;
    branch?: string | null;
    isolation?: SessionIsolation | null;
  }): Promise<SessionProjection>;
  queueList?(sessionId: string): Promise<QueueItemDto[]>;
  /** Temporarily holds the queue head while it is edited in the composer. */
  queueEditStart?(sessionId: string, queueId: string): Promise<QueueItemDto>;
  queueEdit?(sessionId: string, queueId: string, text: string): Promise<QueueItemDto>;
  queueSendNow?(sessionId: string, queueId: string, text: string): Promise<SendResult>;
  queueEditCancel?(sessionId: string, queueId: string): Promise<void>;
  queueReorder?(sessionId: string, ids: string[]): Promise<QueueItemDto[]>;
  queueRemove?(sessionId: string, queueId: string): Promise<void>;
  /** Pin/unpin a model-visible message by its canonical source-event sequence. */
  pinContext?(sessionId: string, sourceEventSeq: number): Promise<SessionEvent>;
  unpinContext?(sessionId: string, sourceEventSeq: number): Promise<SessionEvent>;
  /** F14 import half: backend sessions not yet adopted (items) + how many the
   *  backend has in total, so the UI can tell "none exist" from "all imported". */
  backendSessions?(projectId: string): Promise<{ items: RuntimeSession[]; total: number }>;
  /** Adopt the selected backend sessions; returns the new projections. */
  importBackendSessions?(projectId: string, backendIds: string[]): Promise<SessionProjection[]>;
  /** F18: read the session's auto-accept policy (own setting + effective). */
  autoAcceptGet?(sessionId: string): Promise<AutoAcceptDto>;
  /** F18: set the policy; enabling reconciles already-pending requests. */
  autoAcceptSet?(sessionId: string, setting: AutoAcceptSetting): Promise<AutoAcceptDto>;
  /** User-confirmed borrowed/external runtime replacement. Never auto-epochs. */
  confirmBorrowedRuntimeEpoch?(sessionId: string): Promise<SessionProjection>;
  /** Persist a per-session composer draft server-side (synced via projection). */
  saveDraft?(sessionId: string, text: string, expectedDraftUpdatedAt?: number | null): Promise<DraftSaveResult>;
  /** Advance the user's read cursor (highest seen event seq) and broadcast the
   *  updated attention so navigator unread bold reflects what was viewed. */
  markRead?(sessionId: string, seq: number): Promise<void>;
}

/** Authoritative draft-write receipt. A conflict means no projection mutation. */
export interface DraftSaveResult { draftUpdatedAt: number }

export interface ClientMutationStatusDto {
  state: DurableOperationState | "queued" | "absent";
  mutationKind?: RuntimeMutationKind | "queue-admission";
  updatedAt?: number;
  code?: string;
  message?: string;
}

export interface SessionOrganizePatch {
  /** null clears the folder assignment */
  folderId?: string | null;
  labelIds?: string[];
  /** null unpins; position controls ordering in the pinned sidebar section. */
  pinned?: { position: number } | null;
}

// ---------------------------------------------------------------- persistence

/** One copied event of an atomic child snapshot. Copied events keep their
 *  exact source times and payloads but receive fresh child ids; `sourceSeq`
 *  records lineage provenance instead of reusing one event id across sessions. */
export interface ChildSnapshotEvent {
  time: number;
  type: string;
  data: JsonObject;
  ignorable?: boolean;
  surfaceOp?: "append" | "replace";
  producerPlugin?: string;
  /** Source-session seq this copied event was derived from. */
  sourceSeq?: number;
}

/** Atomic child publication: prefix events + projection + one lineage marker
 *  commit in a single store transaction or not at all. */
export interface ChildSnapshotInput {
  childSessionId: string;
  events: ChildSnapshotEvent[];
  projection: SessionProjection;
  marker: { type: string; data: JsonObject; ignorable?: boolean };
}

export interface ChildSnapshotResult {
  events: SessionEvent[];
  marker: SessionEvent;
}

/** Keyset pagination for event reads. `limit` returns the NEWEST matching
 *  events (still in ascending seq order); `beforeSeq` bounds the window from
 *  above so older history pages backward without offset scans. */
export interface EventPage {
  /** Exclusive upper bound: only events with seq < beforeSeq. */
  beforeSeq?: number;
  /** Maximum number of events; the newest ones in the window are returned. */
  limit?: number;
  /** Browser intent. `true` is a cache-only prefetch that must not attach or
   *  wake a runtime; `false` is an interactive open/reconcile. Omitted keeps
   *  persistence and non-browser callers' existing read behavior. */
  prefetch?: boolean;
}

export interface SessionPersistence {
  /** Bounded atomic append and optional publication. expectedSeq is a CAS guard. */
  appendBatch?(sessionId: string, events: Array<CanonicalEventInput & { time?: number }>, opts?: { projection?: SessionProjection; expectedSeq?: number; markRead?: boolean }): Promise<SessionEvent[]>;
  append(sessionId: string, type: string, data: JsonObject, opts?: Partial<Pick<SessionEvent, "ignorable" | "surfaceOp" | "sourceEventSeqs" | "producerPlugin">>): Promise<SessionEvent>;
  events(sessionId: string, afterSeq?: number, page?: EventPage): Promise<SessionEvent[]>;
  /** Indexed existence check (no full-log scan). Optional so fakes stay valid. */
  hasEventOfType?(sessionId: string, type: string): Promise<boolean>;
  latestSeq(sessionId: string): Promise<number>;
  copyTo(srcSessionId: string, dstSessionId: string, upToSeq?: number): Promise<void>;
  upsertProjection(p: SessionProjection): Promise<void>;
  projection(sessionId: string): Promise<SessionProjection | undefined>;
  /** `opts.spaceId` restricts the listing to one tenant. Callers that hold a
   *  SpaceContext must always pass it — it is the indexed, authoritative
   *  filter, not a convenience. */
  projections(projectId?: string, opts?: { spaceId?: string }): Promise<SessionProjection[]>;
  /** All-or-nothing child snapshot (per-message fork publication). Optional so
   *  existing fakes remain valid; callers must treat absence as unsupported. */
  publishChildSession?(input: ChildSnapshotInput): Promise<ChildSnapshotResult>;
  /** Atomic read-modify-write on the latest projection row. Returns the exact
   *  committed projection (broadcast that, never a stale in-memory copy). */
  patchProjection?(sessionId: string, patch: (current: SessionProjection) => SessionProjection): Promise<SessionProjection | undefined>;
  /** Hard-delete one session's events, projection, and queued messages in a
   *  single transaction. Optional so existing fakes remain valid. */
  deleteSession?(sessionId: string): Promise<void>;
  /** Advance the user's read cursor (highest seen event seq); returns whether
   *  it moved. Optional so existing fakes remain valid. */
  setReadCursor?(sessionId: string, seq: number): Promise<boolean>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- agent runtime (backend seam)

/** Runtime location is explicit in every binding; callers normalize directory
 * before constructing it. */
export interface RuntimeLocation {
  directory: string;
  workspace?: string;
}

export type RuntimeControl =
  | { kind: "owned"; instanceToken: string }
  | { kind: "borrowed"; source: "shared" | "external" };

export type RuntimeConfigAuthority =
  | { kind: "read-only" }
  | { kind: "writable"; targetId: string };

/** Environment variable names and resolvers are capabilities, not persisted
 * credential values. */
export type RuntimeAuthentication =
  | { kind: "none" }
  | { kind: "basic-env"; usernameEnv: string; passwordEnv: string }
  | { kind: "endpoint-headers"; resolve: () => Promise<Record<string, string>> };

export interface RuntimeEndpoint {
  authorityId: string;
  continuity: "verified" | "generation-only";
  generation: number;
  url: string;
  location: RuntimeLocation;
  control: RuntimeControl;
  config: RuntimeConfigAuthority;
  authentication: RuntimeAuthentication;
}

export interface BaseRuntimeEndpointLease {
  endpoint(): Promise<RuntimeEndpoint>;
  refresh(reason: "connect" | "disconnect" | "unauthorized"): Promise<RuntimeEndpoint>;
  dispose(): Promise<void>;
}

export interface OwnedRuntimeEndpointLease extends BaseRuntimeEndpointLease {
  readonly control: { kind: "owned"; instanceToken: string };
  restart(reason: "crash" | "config" | "manual"): Promise<RuntimeEndpoint>;
}

export interface BorrowedRuntimeEndpointLease extends BaseRuntimeEndpointLease {
  readonly control: { kind: "borrowed"; source: "shared" | "external" };
}

export type RuntimeEndpointLease = OwnedRuntimeEndpointLease | BorrowedRuntimeEndpointLease;

export type ReplayPolicy =
  | { kind: "never" }
  | { kind: "same-operation-id"; contract: string };

export type MutationOutcome<T> =
  | { kind: "confirmed"; value: T; receipt?: string }
  | { kind: "rejected"; code: string; message: string }
  | { kind: "unknown"; operationId: string; message: string };

export type MutationTransportResult<T> =
  | {
      kind: "response";
      status: number;
      headers: Readonly<Record<string, string>>;
      body: T;
    }
  | { kind: "unknown"; operationId: string; message: string };

/** Wire paths remain adapter-private values. No provider DTO crosses this
 * query/mutation/stream safety boundary. */
export interface OpenCodeTransport {
  query<T>(request: {
    method: "GET" | "HEAD";
    path: string;
    deadlineMs: number;
  }): Promise<T>;
  mutate<T>(request: {
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    body?: unknown;
    operationId: string;
    deadlineMs: number;
    replay: ReplayPolicy;
  }): Promise<MutationTransportResult<T>>;
  stream(request: {
    path: string;
    after?: string;
    signal: AbortSignal;
    onEvent(value: unknown): void;
  }): Promise<void>;
}

/** Normalized mutation names used in durable rows and canonical events. */
export type RuntimeMutationKind =
  | "session-create"
  | "session-reset"
  | "session-fork"
  | "session-revert"
  | "turn-submit"
  | "turn-steer"
  | "turn-abort"
  | "session-compact"
  | "session-delete"
  | "permission-reply"
  | "question-reply"
  | "question-reject"
  | "secret-reply";

export interface RuntimeSessionBinding {
  canonicalSessionId: string;
  backendSessionId?: string;
  authorityId: string;
  generation: number;
  continuity: "verified" | "generation-only";
  location: RuntimeLocation;
}

export type RuntimeReconciliationBinding = RuntimeSessionBinding & {
  reconciliationOrdinal?: number;
  /** Durable per-entity checkpoints already canonicalized for this backend
   * session. Pull reconstruction derives canonical facts from final upstream
   * state, so without them it cannot know which facts Polyth already holds. */
  checkpoints?: readonly ObservationCheckpoint[];
};

export interface PersistedRuntimeBinding {
  backendSessionId: string;
  authorityId: string;
  generation: number;
  /** Deliberate backend-identity break counter. Missing on legacy rows means epoch 0. */
  epoch?: number;
  continuity: "verified" | "generation-only";
  protocol: "legacy" | "v2";
  location: RuntimeLocation;
  /** First-reconciliation handling for backend history already represented by
   * canonical copied events, or intentionally imported from the backend. */
  historyBaseline?: "empty" | "copied" | "import";
}

export interface RuntimeTurnBinding {
  session: RuntimeSessionBinding;
  text: string;
  command?: { id: string; owner: "native"; name: string; args?: string };
  attachments?: AttachmentRef[];
  model?: ModelRef;
  agent?: string;
}

export interface RuntimeSnapshot {
  authorityId: string;
  generation: number;
  location: RuntimeLocation;
  backendSessionId: string;
  reconciliationOrdinal: number;
  state: {
    value: "running" | "idle" | "failed" | "interrupted" | "unknown";
    watermark?: string;
    /** Provider-normalized monotonic evidence. A terminal state is destructive
     * only when this order is comparable with the stored order for `domain`. */
    comparison?: {
      domain: string;
      order: number;
    };
    /** Exact confirmed operation that makes a fresh-session idle state causal
     * without pretending its unversioned status text is monotonic evidence. */
    causalOperationId?: string;
  };
  completeness: {
    events: "complete" | "partial" | "unverifiable";
    permissions: "complete" | "partial" | "unverifiable";
    questions: "complete" | "partial" | "unverifiable";
  };
  cursorAfter?: string;
  permissions: Array<{
    requestId: string;
    permission: string;
    patterns: string[];
    /** Stable upstream entity revision when the protocol exposes one. */
    revision?: string;
  }>;
  questions: Array<{
    requestId: string;
    questions: JsonObject[];
    /** Stable upstream entity revision when the protocol exposes one. */
    revision?: string;
  }>;
  /** One native observation with every canonical event normalization derived
   * from it. The members are one admission unit: identity, state rank and
   * checkpoint decide once for the whole entry, so a split member can never
   * suppress its siblings and a re-observed source can never re-append them. */
  events: Array<{
    entityKey: string;
    revision: string;
    artifactKind?: ObservationArtifactKind;
    events: RuntimeEvent[];
    stateRank?: number;
    checkpoint?: JsonObject;
  }>;
  /** Protocol-proven links between durable Polyth operations and accepted
   * upstream entities. Adapters omit this when the backend exposes no stable
   * operation receipt; equal content is never evidence. */
  acceptedOperations?: Array<{
    operationId: string;
    mutationKind: RuntimeMutationKind;
    receipt?: string;
    entityId?: string;
    backendSessionId?: string;
  }>;
  /** Protocol-proven evidence that a specific durable operation had no
   * upstream effect. Completeness alone is not causal proof; adapters omit
   * this unless an operation lookup or pinned causally-newer snapshot contract
   * proves non-application. */
  nonAppliedOperations?: Array<{
    operationId: string;
    mutationKind: RuntimeMutationKind;
    requestId?: string;
    backendSessionId?: string;
  }>;
}

/** A protocol-neutral, semantically identified runtime observation. SSE and
 * pull/history producers use the same identity so the session store can claim
 * the canonical event batch exactly once. */
export interface RuntimeObservation {
  channel: "sse" | "pull";
  entityKey: string;
  identity: ObservationIdentity;
  reconciliationOrdinal: number;
  events: RuntimeEvent[];
  /** Explicit non-model-visible evidence that an identified upstream artifact
   * cannot be merged with the durable checkpoint without guessing. */
  uncertainty?: {
    code: "divergent-content" | "terminal-payload-changed";
    message: string;
  };
  checkpoint?: {
    stateRank?: number;
    value: JsonObject;
  };
  cursorAfter?: string;
}

/** Runtime connectivity notifications are evidence triggers, not mutation
 * outcomes. Consumers reconcile durable sessions before reopening admission. */
export type RuntimeLifecycleNotification =
  | {
      type: "stream-connected" | "stream-disconnected";
      authorityId?: string;
      generation?: number;
      reason?: string;
    }
  | {
      type: "endpoint-replaced";
      authorityId: string;
      generation: number;
      reason: "connect" | "disconnect" | "unauthorized" | "crash" | "config" | "manual";
    };

export interface ProtocolCapabilities {
  eventReplay: "none" | "contract-tested";
  pendingSnapshot: "none" | "partial" | "complete-causal";
  idempotentMutations: ReadonlySet<RuntimeMutationKind>;
  /** Read-only negotiated native surfaces for this protocol generation. */
  commands?: boolean;
  compaction?: boolean;
}

/** One provider the backend can list — id + display name only. Used for the
 *  "add a provider" picker, never the (potentially huge) per-model payload. */
export interface AvailableProviderDescriptor {
  id: string;
  name: string;
  /** Declared environment variable *names* (never values) the provider reads. */
  env?: string[];
  /** Documentation / "get a key" URL when the catalog supplies one. */
  docs?: string;
}

/** How a provider instance entered the managed set. */
export type ProviderOrigin = "builtin" | "custom" | "externally-configured";

/** Quiet user-facing readiness. Distinct from `enabled` (visibility toggle). */
export type ProviderStatus = "ready" | "needs-setup" | "disabled";

export interface ProviderStatusInput {
  enabled: boolean;
  /** Has a config stanza, explicit add, or live models. */
  configured: boolean;
  /** Polyth or OpenCode stored a credential. Never the secret itself. */
  hasCredential: boolean;
  /** OpenCode reported the provider as currently serving models. */
  connected: boolean;
  /** False when the provider is configured for no-auth. Undefined = assume auth may be required. */
  authRequired?: boolean;
}

/**
 * Derive the single user-facing status.
 *
 * !enabled → Disabled
 * runtime connected → Ready (includes environment auth)
 * known API-key provider without a credential → Needs setup
 * stored credential → Ready
 * configured no-auth provider → Ready
 * otherwise → Needs setup
 *
 * Disconnected catalogue models never imply readiness.
 */
export function deriveProviderStatus(input: ProviderStatusInput): ProviderStatus {
  if (!input.enabled) return "disabled";
  if (input.connected) return "ready";
  if (input.authRequired === true && !input.hasCredential) return "needs-setup";
  if (input.hasCredential) return "ready";
  if (input.configured && input.authRequired === false) return "ready";
  return "needs-setup";
}

/** Controlled custom-provider adapters. Never accept an arbitrary npm spec. */
export type CustomProviderProtocol = "openai-compatible" | "openai-responses";

/** npm packages Polyth may write for custom providers. The UI never supplies these. */
export const CUSTOM_PROVIDER_ADAPTERS: Record<CustomProviderProtocol, string> = {
  "openai-compatible": "@ai-sdk/openai-compatible",
  "openai-responses": "@ai-sdk/openai",
};

export type CustomProviderAuthMode = "api-key" | "none";

/** Precise header mutation. Omit the whole patch to leave existing headers
 *  untouched. OpenCode stores these values in provider options — Polyth never
 *  returns the values on public DTOs. */
export interface CustomProviderHeaderPatch {
  /** Replace/add only these names. */
  set?: Record<string, string>;
  /** Delete only these names. */
  unset?: string[];
  /** Drop every header, then apply `set` if present. */
  clear?: boolean;
}

/** Polyth-owned slice written into `opencode.json` `provider.<id>`. Only
 *  OpenCode-understood fields are persisted there. Secrets go through
 *  OpenCode auth; Polyth ownership/authMode live in Polyth persistence. */
export interface CustomProviderApply {
  id: string;
  name: string;
  protocol: CustomProviderProtocol;
  baseURL: string;
  authMode?: CustomProviderAuthMode;
  headerPatch?: CustomProviderHeaderPatch;
  /** Merge by model id. Discovery is merge-only and never deletes models. */
  models?: Record<string, CustomProviderModelApply>;
}

export interface CustomProviderModelApply {
  name?: string;
  context?: number;
  output?: number;
}

export interface CustomProviderConfigDto {
  protocol: CustomProviderProtocol;
  baseURL: string;
  /** Absent when Polyth does not know the auth requirement. */
  authMode?: CustomProviderAuthMode;
  hasHeaders: boolean;
  /** Names only — never values. */
  headerNames: string[];
  /** Models declared in the Polyth-owned config stanza. */
  modelIDs?: string[];
}

/** Server-side view of one provider stanza. Header values stay here and must
 *  never be copied into a browser DTO. */
export interface ProviderInspect {
  id: string;
  name: string;
  owned: boolean;
  protocol?: CustomProviderProtocol;
  authMode?: CustomProviderAuthMode;
  baseURL?: string;
  /** Server-only. Never serialize this object to the browser. */
  headers?: Record<string, string>;
  headerNames: string[];
  modelIDs: string[];
}

/** Narrow config port so feature packages do not import OpenCode internals. */
export interface ProviderConfigPort {
  readConfig(): Promise<Record<string, unknown>>;
  applyCustomProvider(input: CustomProviderApply): Promise<void>;
  /** Remove a Polyth-owned custom provider stanza. Unknown sibling providers
   *  and unowned fields of other entries are preserved. */
  removeCustomProvider(id: string): Promise<void>;
  inspectProvider(id: string): Promise<ProviderInspect | undefined>;
  mergeDiscoveredModels(
    id: string,
    discovered: ReadonlyArray<{ id: string; name?: string }>,
  ): Promise<void>;
  addManualModel(id: string, model: CustomProviderModelApply & { id: string }): Promise<void>;
  /** Remove one Polyth-configured model id. Sibling models and unknown fields stay. */
  removeConfiguredModel(id: string, modelId: string): Promise<void>;
}

export interface ProviderAuthPromptOption {
  label: string;
  value: string;
  hint?: string;
}

/** One extra field a provider's login flow needs before it can start (e.g.
 *  GitLab's instance URL, GitHub Enterprise's deployment type). */
export interface ProviderAuthPrompt {
  type: "text" | "select";
  key: string;
  message: string;
  placeholder?: string;
  options?: ProviderAuthPromptOption[];
  when?: { key: string; op: "eq" | "neq"; value: string };
}

/** One way to authenticate a provider as reported by the OpenCode wire.
 *  Current upstream only emits `oauth` and `api`. `upstreamIndex` is the
 *  original array index on that provider's method list — it is not recomputed
 *  after skipping malformed entries. */
export interface ProviderAuthMethod {
  type: "oauth" | "api";
  label: string;
  prompts?: ProviderAuthPrompt[];
  upstreamIndex: number;
}

/** Current OpenCode authorize HTTP body: url, method, instructions only. */
export interface ProviderAuthorization {
  url: string;
  method: "auto" | "code";
  instructions: string;
}

/** Persist a credential through OpenCode PUT /auth/:id. Never sent to browsers. */
export type ProviderAuthWrite =
  | { type: "api"; key: string; metadata?: Record<string, string> }
  | { type: "wellknown"; key: string; token: string };

export type AuthMethodKind = "oauth" | "api";

export type AuthFieldKind = "text" | "secret" | "url" | "email" | "otp" | "select" | "boolean";

export type AuthProvenance =
  | "opencode-plugin"
  | "provider-metadata"
  | "environment";

export type AuthCapabilityStatus = "loaded" | "empty" | "unavailable" | "failed";

export type AuthPhase =
  | "starting"
  | "browser_action_required"
  | "device_action_required"
  | "awaiting_code"
  | "waiting"
  | "validating"
  | "connected"
  | "configured_unverified"
  | "failed"
  | "denied"
  | "expired"
  | "cancelled"
  | "stale";

export type AuthErrorCode =
  | "AUTH_CAPABILITY_UNAVAILABLE"
  | "AUTH_DISCOVERY_FAILED"
  | "AUTH_METHOD_UNAVAILABLE"
  | "AUTH_INPUT_INVALID"
  | "AUTH_CREDENTIAL_INVALID"
  | "AUTH_DENIED"
  | "AUTH_EXPIRED"
  | "AUTH_CALLBACK_FAILED"
  | "AUTH_SAVE_FAILED"
  | "AUTH_SESSION_STALE"
  | "AUTH_RUNTIME_RESTARTED"
  | "AUTH_REMOTE_LOOPBACK_UNREACHABLE"
  | "AUTH_PROVIDER_UNREACHABLE"
  | "AUTH_RATE_LIMITED"
  | "AUTH_NETWORK_ERROR"
  | "AUTH_PROVIDER_PROTOCOL_CHANGED"
  | "AUTH_WELLKNOWN_UNSAFE"
  | "AUTH_CANCELLED";

export type CredentialSourceKind =
  | "none"
  | "environment"
  | "unknown";

export type CredentialVerification = "verified" | "saved" | "unverified" | "invalid" | "needs_reauth";

export type AuthUrlKind = "authorization" | "device_verification" | "informational" | "unknown";

export interface AuthErrorDto {
  code: AuthErrorCode;
  message: string;
  details?: string;
  field?: string;
}

export interface NormalizedAuthField {
  key: string;
  kind: AuthFieldKind;
  label: string;
  placeholder?: string;
  options?: ProviderAuthPromptOption[];
  when?: { key: string; op: "eq" | "neq"; value: string };
  secret: boolean;
  autocomplete?: string;
}

export interface NormalizedAuthMethod {
  id: string;
  upstreamIndex: number;
  fingerprint: string;
  provenance: AuthProvenance;
  kind: AuthMethodKind;
  label: string;
  fields: NormalizedAuthField[];
  usable: boolean;
  unavailability?: AuthErrorDto;
  docsUrl?: string;
}

export interface ProviderCredentialStatus {
  source: CredentialSourceKind;
  verification: CredentialVerification;
  accountHint?: string;
  expiresAt?: number;
  /** Environment variable *names* still supplying credentials after a disconnect. */
  envVarNames?: string[];
}

export interface AuthAttemptDto {
  id: string;
  providerId: string;
  methodId: string;
  upstreamIndex: number;
  fingerprint: string;
  revision: string;
  authorityId: string;
  generation: number;
  phase: AuthPhase;
  createdAt: number;
  expiresAt?: number;
  instructions?: string;
  url?: string;
  urlKind?: AuthUrlKind;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  loopbackWarning?: boolean;
  error?: AuthErrorDto;
}

export interface WellKnownPreviewDto {
  origin: string;
  hash: string;
  command: string[];
  env: string;
}

export interface ProviderAuthView {
  providerId: string;
  discovery: {
    status: AuthCapabilityStatus;
    provenance: AuthProvenance[];
    revision: string;
    authorityId: string;
    generation: number;
    error?: AuthErrorDto;
  };
  methods: NormalizedAuthMethod[];
  credential?: ProviderCredentialStatus;
  activeAttempt?: AuthAttemptDto;
}

export interface ProviderAuthCapabilitiesDto {
  revision: string;
  authorityId: string;
  generation: number;
  discoveredAt: number;
  providers: Record<string, ProviderAuthView>;
  discovery: {
    status: AuthCapabilityStatus;
    provenance: AuthProvenance[];
    error?: AuthErrorDto;
  };
}

export interface ProtocolAdapter {
  readonly protocol: "legacy" | "v2";
  capabilities(): Promise<ProtocolCapabilities>;
  models(): Promise<ModelDescriptor[]>;
  agents(): Promise<AgentDescriptor[]>;
  /** Every provider the backend currently exposes (id + name only) — for the
   *  "add a provider" picker. Optional: legacy backends may not support it. */
  listAllProviders?(): Promise<AvailableProviderDescriptor[]>;
  /** Special login flows registered per provider id. Absence means discovery
   *  could not list methods — it is not an invitation to invent an API key. */
  providerAuthMethods?(): Promise<Record<string, ProviderAuthMethod[]>>;
  /** Start a provider's OAuth flow; `inputs` answers that method's prompts. */
  providerAuthorize?(
    providerID: string,
    method: number,
    inputs?: Record<string, string>,
  ): Promise<ProviderAuthorization>;
  /** Complete OAuth. `code` is omitted for auto/device flows whose callback
   * blocks while the user finishes browser authentication. */
  providerAuthCallback?(providerID: string, method: number, code?: string): Promise<boolean>;
  /** Store a plain API key (plus any extra prompt answers) for a provider. */
  setProviderApiKey?(providerID: string, key: string, metadata?: Record<string, string>): Promise<boolean>;
  /** Persist OpenCode Auth.Info (api or wellknown). Secret values never return. */
  setProviderAuth?(providerID: string, info: ProviderAuthWrite): Promise<boolean>;
  /** Revoke stored credentials for a provider. */
  removeProviderAuth?(providerID: string): Promise<boolean>;
  sessions(): Promise<RuntimeSession[]>;
  history(input: RuntimeSessionBinding): Promise<RuntimeSessionMessage[]>;
  eventStreamPath(): string | undefined;
  ensureSession(
    input: RuntimeSessionBinding,
    operationId: string,
    title?: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>>;
  resetSession(
    input: RuntimeSessionBinding,
    title: string | undefined,
    operationId: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>>;
  branchSession(
    input: {
      source: RuntimeSessionBinding;
      target: RuntimeSessionBinding;
      title?: string;
      history: ModelMessage[];
    },
    operationId: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>>;
  submit(
    input: RuntimeTurnBinding,
    operationId: string,
  ): Promise<MutationOutcome<{ admissionId?: string }>>;
  steer(
    input: RuntimeTurnBinding,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  abort(
    input: RuntimeSessionBinding,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  deleteSession(
    input: RuntimeSessionBinding,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  replyPermission(
    input: RuntimeSessionBinding,
    requestId: string,
    reply: "once" | "always" | "reject",
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  replyQuestion(
    input: RuntimeSessionBinding,
    requestId: string,
    answers: JsonObject,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  commands?(): Promise<RuntimeCommandDescriptor[]>;
  compact?(
    input: RuntimeSessionBinding,
    operationId: string,
    model?: ModelRef,
  ): Promise<MutationOutcome<Record<string, never>>>;
  reconcile(input: RuntimeReconciliationBinding, after?: string): Promise<RuntimeSnapshot>;
}

// ------------------------------------------------ durable mutation/reconciliation vocabulary

export type DurableOperationState =
  | "prepared"
  | "executing"
  | "confirmed"
  | "rejected"
  | "unknown"
  | "not-applied"
  | "fenced";
export type OperationState = DurableOperationState;
export type RuntimeOperationState = DurableOperationState;

export interface DurableOperation {
  operationId: string;
  sessionId: string;
  ordinal: number;
  mutationKind: RuntimeMutationKind;
  state: DurableOperationState;
  replay: ReplayPolicy;
  createdAt: number;
  updatedAt: number;
  code?: string;
  message?: string;
  receipt?: string;
  ownerEventSeq?: number;
}

export interface CanonicalEventInput {
  type: string;
  data: JsonObject;
  ignorable?: boolean;
  surfaceOp?: "append" | "replace";
  sourceEventSeqs?: number[];
  producerPlugin?: string;
}

export interface PrepareOperationInput {
  sessionId: string;
  mutationKind: RuntimeMutationKind;
  /** Optional client-provided UUID. Reuse is accepted only for the exact
   * durable session/kind/intent already recorded in this store. */
  clientOperationId?: string;
  /** Hash of the exact client request bound to a client operation id. It is
   * persisted in the existing mutation/prepared event, not a second ledger. */
  clientRequestFingerprint?: string;
  /** Every generic preparation has one owning intent event in the same
   * transaction. Queue, create, response, and deletion use specialized APIs. */
  intentEvent: CanonicalEventInput;
  replay?: ReplayPolicy;
}

export interface PreparedOperationResult {
  operation: DurableOperation;
  intentEvent: SessionEvent;
  stateEvent: SessionEvent;
}

export interface PrepareSessionCreateInput {
  projection: SessionProjection;
  createdEvent: CanonicalEventInput;
  replay?: ReplayPolicy;
}

export interface PreparedSessionCreateResult {
  operation: DurableOperation;
  createdEvent: SessionEvent;
  stateEvent: SessionEvent;
  projection: SessionProjection;
}

/** Atomic durable half of an epoch replacement. The reset operation must
 * already be protocol-confirmed with the replacement backend session receipt.
 * Pre-reset prepared operations are rejected and executing operations become
 * unknown. Only an owned fence may then move those unknowns to fenced. */
export interface RuntimeEpochTransitionInput {
  sessionId: string;
  expectedBinding: PersistedRuntimeBinding;
  replacementBinding: PersistedRuntimeBinding;
  resetOperationId: string;
  reason: string;
  /** Atomically publish routing with the fresh runtime binding. */
  harness?: { transitionId: string; selection: HarnessSelection; leg: RuntimeLeg };
  fence?: RuntimeEpochFence;
}

export interface RuntimeEpochTransitionResult {
  marker: SessionEvent;
  projection: SessionProjection;
  fencedOperations: DurableOperation[];
  heldQueueItems: QueueItemDto[];
}

/** Warm-restart recovery for a session whose in-flight turn was interrupted
 *  by a Polyth restart (`executing` → `unknown` at boot) but whose owned
 *  backend session is still alive and has been re-verified by reconciliation.
 *  Writes an ignorable `runtime/restart-recovered` marker naming the stranded
 *  `turn-submit` / `turn-steer` operations and holds any reserved queue draft
 *  for review. The operations stay `unknown` (never auto-resolved); the marker
 *  only lifts them out of the send-admission barrier. No binding change. */
export interface RuntimeRestartRecoveryInput {
  sessionId: string;
  authorityId: string;
  generation: number;
  reconciliationOrdinal: number;
}

export interface RuntimeRestartRecoveryResult {
  marker: SessionEvent;
  recoveredOperationIds: string[];
  heldQueueItems: QueueItemDto[];
}

export type OperationClaimResult =
  | { kind: "claimed"; operation: DurableOperation; event?: SessionEvent }
  | { kind: "not-claimed"; operation?: DurableOperation };

export type OperationSettlement =
  | { kind: "confirmed"; receipt?: string }
  | { kind: "rejected"; code: string; message: string }
  | { kind: "unknown"; code?: string; message: string }
  | { kind: "not-applied"; code?: string; message: string };

export interface QueueReservation {
  queueItem: QueueItemDto;
  operation: DurableOperation;
  reservedAt: number;
}

export interface QueueReservationInput {
  sessionId: string;
  mutationKind?: "turn-submit" | "turn-steer";
  replay?: ReplayPolicy;
}

export type QueueReservationResult =
  | { kind: "empty" }
  | { kind: "reserved"; reservation: QueueReservation }
  | { kind: "blocked"; reservation: QueueReservation }
  | { kind: "held"; queueItem: QueueItemDto };

export type ObservationArtifactKind =
  | "message"
  | "part"
  | "tool"
  | "permission"
  | "question"
  | "status"
  | "turn";

/** Generation is captured for audit/fencing but deliberately excluded from
 * durable semantic uniqueness. */
export interface ObservationIdentity {
  authorityId: string;
  generation: number;
  location: RuntimeLocation;
  backendSessionId: string;
  artifactKind: ObservationArtifactKind;
  entityId: string;
  revision: string;
}

export interface ObservationEntityKey {
  authorityId: string;
  location: RuntimeLocation;
  backendSessionId: string;
  artifactKind: ObservationArtifactKind;
  entityId: string;
}

export interface ObservationCheckpoint {
  key: ObservationEntityKey;
  revision: string;
  stateRank?: number;
  value: JsonObject;
  updatedAt: number;
}

export interface ObservationCursorKey {
  authorityId: string;
  location: RuntimeLocation;
  backendSessionId: string;
  channel: string;
}

export interface ObservationIngestionInput {
  sessionId: string;
  identity: ObservationIdentity;
  reconciliationOrdinal: number;
  events: CanonicalEventInput[];
  checkpoint?: {
    stateRank?: number;
    value: JsonObject;
  };
  cursor?: {
    key: ObservationCursorKey;
    after: string;
  };
}

export interface SnapshotIngestionInput {
  sessionId: string;
  observations: ObservationIngestionInput[];
}

export interface SnapshotIngestionResult {
  observations: ObservationIngestionResult[];
}

export type ObservationIngestionResult =
  | { kind: "applied"; events: SessionEvent[]; checkpoint?: ObservationCheckpoint }
  | { kind: "duplicate"; events: SessionEvent[]; checkpoint?: ObservationCheckpoint };

export type DurableReconciliationState = "reconciling" | "ready" | "blocked" | "unknown";

export interface DurableReconciliation {
  sessionId: string;
  ordinal: number;
  state: DurableReconciliationState;
  reason?: string;
  updatedAt: number;
}

export interface DeletionTombstoneBinding {
  canonicalSessionId: string;
  authorityId: string;
  generation: number;
  location: RuntimeLocation;
  backendSessionId: string;
}

export interface DeletionTombstone {
  binding: DeletionTombstoneBinding;
  operationId: string;
  createdAt: number;
  retiredAt?: number;
  retirement?: { kind: "confirmed" } | { kind: "purged"; policy: string };
}

export interface PrepareDeletionTombstoneInput {
  binding: DeletionTombstoneBinding;
  replay?: ReplayPolicy;
}

export interface PreparedDeletionTombstoneResult {
  tombstone: DeletionTombstone;
  operation: DurableOperation;
}

export type ResponseIntentInput =
  | {
      kind: "permission";
      sessionId: string;
      requestId: string;
      reply: "once" | "always" | "reject";
      scope?: "session" | "project";
      /** Durable provenance for a server-side Auto-Approve decision. */
      auto?: boolean;
    }
  | {
      kind: "question";
      sessionId: string;
      requestId: string;
      answers: JsonObject;
      reject?: boolean;
    }
  | {
      kind: "secret";
      sessionId: string;
      requestId: string;
      action: "save" | "dismiss";
      handle?: string;
    };

export interface DurableResponseIntent {
  kind: ResponseIntentInput["kind"];
  sessionId: string;
  requestId: string;
  operationId: string;
  payload: JsonObject;
  createdAt: number;
}

export type ResponseIntentChoice =
  | { kind: "chosen"; intent: DurableResponseIntent; operation: DurableOperation }
  | { kind: "existing"; intent: DurableResponseIntent; operation: DurableOperation };

export type ResponseIntentSettlement =
  | { kind: "confirmed"; receipt?: string; completionEvent: CanonicalEventInput }
  | { kind: "rejected"; code: string; message: string }
  | { kind: "unknown"; code?: string; message: string }
  | { kind: "not-applied"; code?: string; message: string };

export interface ModelDescriptor { /** Present in aggregated/prospective catalogs; runtime-local catalogs may omit it. */ harnessId?: string; providerID: string; modelID: string; name: string; providerName?: string; context?: number; cost?: { input: number; output: number }; /** Normalized values include `input:text`, `output:image`, `input:none`, `toolcall`, and `attachment`. */ capabilities?: string[]; /** Named reasoning variants the backend advertises for this model (for example low/medium/high). A selected variant is `ModelRef.variant`; there is no parallel thinking field. */ variants?: string[]; /** The variant the backend applies when `ModelRef.variant` is absent, when it names one. */ defaultVariant?: string; /** Provider has live credentials (backend `connected[]`); undefined = unknown/assume connected. */ connected?: boolean }
export interface AgentDescriptor {
  /** Present in aggregated/prospective catalogs; runtime-local catalogs may omit it. */
  harnessId?: string;
  name: string;
  description?: string;
  /** `auto` delegates model selection to the agent that launches this role. */
  mode: "primary" | "subagent" | "all" | "auto";
  /** OpenCode's role-level system prompt, when exposed by the backend. */
  prompt?: string;
  /** Role-specific model override. */
  model?: ModelRef;
}
export interface RuntimeCapabilities {
  streaming: boolean;
  permissions: boolean;
  questions: boolean;
  compaction: boolean;
  subagents: boolean;
  steering?: boolean;
  resume?: boolean;
  usage?: boolean;
  cost?: boolean;
  fork?: boolean;
  mcp?: boolean;
  title?: FeatureSupport;
  attachments?: RuntimeAttachmentSupport;
  commands?: RuntimeCommandSupport;
  contextOccupancy?: TelemetryQuality;
}

// Harnesses construct AgentRuntime; they never own canonical sessions.
export type HarnessSelection = { mode: "auto" } | { mode: "pinned"; harnessId: string };
export interface HarnessDescriptor {
  id: string;
  name: string;
  integration: string;
  /** Default selection order; smaller comes first. */
  priority: number;
  autoSelect?: boolean;
  setupUrl?: string;
  installCommand?: string;
  signInCommand?: string;
}
/** Stable, process-free presentation metadata for the harness picker. */
export interface HarnessRosterItem {
  identity: Pick<HarnessDescriptor, "id" | "name" | "integration">;
  policy: {
    enabled: boolean;
    priority: number;
    autoSelect: boolean;
  };
}
export type HarnessAvailabilityState =
  | "not-installed"
  | "starting"
  | "ready"
  | "setup-required"
  | "auth-required"
  | "partially-configured"
  | "degraded"
  | "offline"
  | "incompatible"
  | "unknown";
export interface HarnessProbe {
  harnessId: string;
  installed: boolean;
  authenticated: boolean | "unknown";
  healthy: boolean;
  version?: string;
  message?: string;
  /** Legacy providers may omit this; the registry derives it conservatively. */
  state?: HarnessAvailabilityState;
}
export type HarnessControlKind = "toggle" | "select" | "text" | "action";
export type HarnessControlScope = "draft" | "session" | "project" | "harness";
export type HarnessControlPlacement =
  | "composer-primary"
  | "composer-more"
  | "harness-overview"
  | "harness-settings";
export type HarnessControlApplySemantics =
  | "live"
  | "next-turn"
  | "restart-required"
  | "new-session-only"
  | "read-only";
export interface HarnessControlDescriptor {
  id: string;
  label: string;
  description?: string;
  kind: HarnessControlKind;
  scope: HarnessControlScope;
  placement?: HarnessControlPlacement;
  priority?: number;
  applySemantics: HarnessControlApplySemantics;
  danger?: "none" | "confirm" | "destructive";
  available?: boolean;
  unavailableReason?: string;
  choices?: Array<{ value: string; label: string; description?: string }>;
  value?: JsonValue;
}
export interface HarnessDiscovery {
  /** Readiness learned during lazy native discovery. This refines the cheap
   * probe without requiring every harness to start while chat is opening. */
  state?: HarnessAvailabilityState;
  authenticated?: boolean | "unknown";
  message?: string;
  capabilities?: RuntimeCapabilities;
  catalog?: {
    providers?: Array<{ id: string; name: string; connected?: boolean }>;
    models?: ModelDescriptor[];
    agents?: AgentDescriptor[];
    roles?: AgentDescriptor[];
    modes?: string[];
    features?: string[];
  };
  controls?: HarnessControlDescriptor[];
  restartRequired?: boolean;
  pendingChanges?: number;
  native?: JsonValue;
}
/** Cheap, read-only configuration state that does not require native startup. */
export interface HarnessConfigurationMetadata {
  restartRequired?: boolean;
  pendingChanges?: number;
}
export interface HarnessSnapshot {
  identity: {
    id: string;
    name: string;
    integration: string;
    version?: string;
  };
  availability: HarnessProbe & { state: HarnessAvailabilityState; checkedAt: number };
  policy: {
    enabled: boolean;
    priority: number;
    autoSelect: boolean;
  };
  setup?: {
    installCommand?: string;
    signInCommand?: string;
    setupUrl?: string;
  };
  capabilities?: RuntimeCapabilities;
  /** Static projection support for desired agent capabilities. This is safe to
   * expose before a native runtime or detail discovery exists. */
  capabilitySupport?: HarnessCapabilitySupport;
  catalog?: HarnessDiscovery["catalog"];
  configuration?: {
    controls: HarnessControlDescriptor[];
    restartRequired?: boolean;
    pendingChanges?: number;
  };
  context: {
    spaceId: string;
    projectId: string;
    cwd: string;
    remote?: boolean;
    revision: string;
    fetchedAt: number;
  };
  stale?: boolean;
  refreshing?: boolean;
  message?: string;
  native?: JsonValue;
}
export interface HarnessContext {
  /** Server-validated context for provider-owned per-Space storage. */
  space?: SpaceContext;
  spaceId: string;
  projectId: string;
  cwd: string;
  /** Session-specific engines must isolate their native maps and processes. */
  sessionId?: string;
  model?: ModelRef;
  remote?: boolean;
}

/** What Polyth wants an agent to have. Distinct from RuntimeCapabilities, which
 * describe execution features of a live AgentRuntime. */
export type AgentCapabilityKind =
  | "instruction"
  | "mcp-server"
  | "tool"
  | "skill"
  | "context"
  | "extension";
export type AgentCapabilityScope = "deployment" | "space" | "project" | "session";
/** How a harness actually delivers a capability. `unsupported` is explicit. */
export type CapabilityProjectionMode =
  | "native"
  | "mcp"
  | "prompt"
  | "filesystem"
  | "config"
  | "emulated"
  | "unsupported";
export type CapabilityMutability =
  | "immediate"
  | "session-create"
  | "requires-restart"
  | "immutable";
export type CapabilityProvisionStatus =
  | "applied"
  | "pending"
  | "pending-restart"
  | "degraded"
  | "unsupported"
  | "failed"
  | "unverifiable";

export interface AgentCapabilitySupport {
  modes: readonly CapabilityProjectionMode[];
  mutability: CapabilityMutability;
  /** False when this kind cannot safely leave the local host. Default true for local. */
  remote?: boolean;
  /** Where this harness materializes the capability. A desired scope narrower
   * than this is unsupported rather than collapsed onto a wider config file. */
  configScope?: AgentCapabilityScope;
}

/** Who owns volatile application state. Independent of `configScope`. */
export type HarnessCapabilityTargetLifetime = "session" | "physical-runtime";

export interface HarnessCapabilitySupport {
  harnessId: string;
  /** Defaults to `session`. OpenCode project overlays use `physical-runtime`. */
  targetLifetime?: HarnessCapabilityTargetLifetime;
  kinds: { [K in AgentCapabilityKind]?: AgentCapabilitySupport };
}

/** Evidence supplied by a harness for a capability projection. The source is
 * a short, sanitized description of the observation; it must not contain
 * prompts, credentials or tool output. */
export type HarnessCapabilityEvidenceStage = "staged" | "discovered" | "connected" | "invocable";
export interface HarnessCapabilityEvidence {
  stage: HarnessCapabilityEvidenceStage;
  source: string;
}

/** Fields shared by every capability descriptor. `spaceId`/`projectId` filter
 * resolution when a contribution is not deployment-wide. */
export interface AgentCapabilityBase {
  id: string;
  owner: string;
  scope: AgentCapabilityScope;
  revision: string;
  spaceId?: string;
  projectId?: string;
}

/** Serializable desired-state descriptor. Executors and secret values never appear. */
export type AgentCapabilityDescriptor =
  | (AgentCapabilityBase & {
      kind: "instruction";
      title?: string;
      text: string;
    })
  | (AgentCapabilityBase & {
      kind: "mcp-server";
      name: string;
      enabled: boolean;
      transport: McpTransport;
      raw?: JsonObject;
    })
  | (AgentCapabilityBase & {
      kind: "tool";
      name: string;
      description: string;
      inputSchema: JsonObject;
      trust: TrustClass;
      mutating: boolean;
    })
  | (AgentCapabilityBase & {
      kind: "skill";
      name: string;
      title: string;
      description: string;
      instructions: string;
    })
  | (AgentCapabilityBase & {
      kind: "context";
      title: string;
      text: string;
    })
  | (AgentCapabilityBase & {
      kind: "extension";
      namespace: string;
      schemaVersion: string;
      value: JsonValue;
    });

/** Grant passed to package-owned package-tool authorization hooks. */
export interface AgentToolAuthorizationGrant {
  spaceId: string;
  projectId: string;
  cwd: string;
  harnessId?: string;
  sessionId?: string;
  /** Host-resolved Space storage when the grant Space is known. Never client-derived. */
  storage?: SpaceStorage;
}

export interface AgentCapabilityContribution {
  descriptor: AgentCapabilityDescriptor;
  /** Trusted in-process handler. Never serialized; never sent to a model. */
  execute?: ToolExecutor;
  /** Optional package-owned auto-approval for package-tool authorization.
   *  Never serialized; must not override permission deny rules. */
  autoApprove?: (grant: AgentToolAuthorizationGrant) => boolean | Promise<boolean>;
}

export interface HarnessCapabilityRecord {
  capabilityId: string;
  kind: AgentCapabilityKind;
  owner: string;
  desiredRevision: string;
  appliedRevision?: string;
  mode: CapabilityProjectionMode;
  status: CapabilityProvisionStatus;
  mutability?: CapabilityMutability;
  /** Sanitized reason. Must never contain secret values or full prompts. */
  reason?: string;
  /** Optional positive observation of the capability projection. */
  evidence?: HarnessCapabilityEvidence;
}

export interface HarnessProvisioningPlan {
  harnessId: string;
  desiredRevision: string;
  items: Array<{
    capability: AgentCapabilityDescriptor;
    mode: CapabilityProjectionMode;
    mutability: CapabilityMutability;
  }>;
  /** Controller-owned revision retention set for physical-runtime cleanup. */
  keepRevisions?: readonly string[];
}

export interface HarnessProvisioningResult {
  harnessId: string;
  desiredRevision: string;
  records: HarnessCapabilityRecord[];
}

/** Resolves secret handles at the trusted apply boundary only. */
export interface CapabilitySecretResolver {
  mcpSecrets(serverId: string): Record<string, string>;
}

/** Identity of a native materialization target. Desired state may be Space or
 * project scoped; application state is always this target. */
export interface HarnessProvisioningTarget {
  spaceId: string;
  projectId: string;
  cwd: string;
  harnessId: string;
  sessionId?: string;
  authorityId?: string;
  generation?: number;
}

/** Native admission acknowledgement. `applied` requires capability-specific
 * evidence that the current target is using the revision; `unverifiable` means
 * the native create API accepted the payload without sufficient observation. */
export interface HarnessCapabilityApplicationReceipt {
  target: HarnessProvisioningTarget;
  desiredRevision: string;
  capabilityIds: string[];
  outcome: Extract<CapabilityProvisionStatus, "applied" | "unverifiable" | "failed">;
  reason?: string;
  /** Optional positive observation of the capability projection. */
  evidence?: HarnessCapabilityEvidence;
}

/** Durable negative intent for a retired native MCP name. Canonical deletion
 * must win over backend discovery after restart. */
export interface McpTombstone {
  name: string;
  revision: number;
  retiredAt: number;
}

export interface HarnessProvisioner {
  /** Process-free projection metadata. This is used by cheap harness
   * snapshots, so it must not start a runtime or perform native discovery. */
  support(context: HarnessContext): HarnessCapabilitySupport | Promise<HarnessCapabilitySupport>;
  apply(
    context: HarnessContext,
    plan: HarnessProvisioningPlan,
    secrets: CapabilitySecretResolver,
  ): Promise<HarnessProvisioningResult>;
  /** Drop launch overlays and other volatile target state. Never deletes
   * user-owned backend configuration. */
  release?(context: HarnessContext, options?: { keepRevisions?: readonly string[] }): void;
}

export interface AgentCapabilityContributionRegistry {
  register(owner: string, contribution: AgentCapabilityContribution): Disposable;
  list(): AgentCapabilityContribution[];
  /** Descriptors visible in this Space/project/session. Executors stay behind the registry. */
  resolve(context: HarnessContext): AgentCapabilityDescriptor[];
  contribution(capabilityId: string): AgentCapabilityContribution | undefined;
  executor(capabilityId: string): ToolExecutor | undefined;
}

export interface HarnessCapabilityStatusDto {
  harnessId: string;
  desiredRevision: string;
  records: HarnessCapabilityRecord[];
  target?: HarnessProvisioningTarget;
}

/** Read-only diagnostics for desired vs applied capability state. */
export interface HarnessProvisioningQuery {
  status(context: HarnessContext, harnessId?: string): HarnessCapabilityStatusDto[];
}

export interface HarnessProvider {
  descriptor: HarnessDescriptor;
  /** Ownership of the runtime returned by createRuntime. Session runtimes are
   * disposed when that canonical session releases its lease. Workspace
   * runtimes are shared infrastructure and are retired by their owning pool. */
  runtimeLifetime?: "session" | "workspace";
  /** Static capability surface for idle/unwired sessions; no process start. */
  staticFeatures?: RuntimeCapabilities;
  probe(context: HarnessContext): Promise<HarnessProbe>;
  /** Prospective metadata. Implementations must not create a native execution
   * session merely to answer this call. Expensive discovery is requested only
   * for a selected detail surface. */
  discover?(context: HarnessContext): Promise<HarnessDiscovery>;
  /** Read-only configuration state for cheap snapshots. */
  inspectConfiguration?(context: HarnessContext): Promise<HarnessConfigurationMetadata>;
  /** Explicit metadata refresh. Drop only this context's cached discovery;
   * never modify native configuration or execution state. */
  invalidateDiscovery?(context: HarnessContext): void;
  /** Applies one descriptor-declared, UI-safe native control. Providers retain
   * authority over validation and native config ownership. */
  applyControl?(context: HarnessContext, controlId: string, value: JsonValue): Promise<void>;
  createRuntime(context: HarnessContext): Promise<AgentRuntime>;
  /** Release/fence a persisted execution without constructing a runtime in
   * its workspace. Required for recovery when that workspace vanished. */
  releaseExecution?(context: HarnessContext, binding: RuntimeSessionBinding, operationId: string): Promise<MutationOutcome<ExecutionReleaseProof>>;
  /** Backend-owned projector. Absence means every Polyth capability is unsupported. */
  provisioner?: HarnessProvisioner;
  source?: SessionSourceProvider;
}
export interface HarnessRegistry {
  register(provider: HarnessProvider): Disposable;
  providers(): HarnessProvider[];
  /** Exact Map lookup — no probe, policy, or auto-select. */
  get(id: string): HarnessProvider | undefined;
  probe(context: HarnessContext): Promise<HarnessProbe[]>;
  resolve(context: HarnessContext, selection: HarnessSelection, stickyId?: string): Promise<HarnessProvider>;
  /** Process-free picker metadata. Availability remains owned by snapshots;
   * this roster exists so labels and logos never wait for native probes. */
  roster(context: HarnessContext): Promise<HarnessRosterItem[]>;
  snapshots(context: HarnessContext, options?: { harnessId?: string; force?: boolean; detail?: boolean }): Promise<HarnessSnapshot[]>;
  invalidate(context?: Partial<Pick<HarnessContext, "spaceId" | "projectId" | "cwd" | "remote">> & { harnessId?: string }): void;
}
export interface RuntimeLeg {
  id: string;
  harnessId: string;
  nativeSessionId: string;
  startedAt: number;
  /** Highest effective user/assistant dialogue seq confirmed in native history. */
  canonicalThroughSeq: number;
  /** User-authored role intent, independent of a profile's old model/account route. */
  agentIntent?: string;
  bootstrap: "native-resume" | "continuity" | "empty";
}
/** Provider-proven identity of one session execution incarnation. Abort
 * acknowledgement is not this proof: the named backend session must be idle. */
export interface ExecutionReleaseProof {
  authorityId: string;
  generation: number;
  backendSessionId: string;
}

export type RuntimeEpochFence =
  | { mode: "destroyed"; authorityId: string; generation: number }
  | ({ mode: "session-released" } & ExecutionReleaseProof);

/** Durable switch intent. No target may admit work before the epoch commit. */
export type HarnessTransition = {
  id: string;
  selection: HarnessSelection;
  targetHarnessId: string;
  timing: "after-turn" | "stop-now";
} & (
  | { phase: "requested"; attempt?: number; lastAttemptAt?: number }
  | { phase: "released"; released: ExecutionReleaseProof; attempt?: number; lastAttemptAt?: number }
  | {
      phase: "failed";
      released: ExecutionReleaseProof;
      attempt: number;
      lastAttemptAt: number;
      error: {
        stage: "starting-target" | "creating-native-session" | "publishing-route";
        code?: string;
        message: string;
      };
    }
);
export interface SourceRecord { role: "user" | "assistant"; text: string; time?: number }
export interface SourceSession { ref: string; title: string; updatedAt?: number }
/** Provider-local native ids/paths are opaque outside the source. No live sync. */
export interface SessionSourceProvider {
  list(context: HarnessContext): Promise<SourceSession[]>;
  read(context: HarnessContext, ref: string): AsyncIterable<SourceRecord>;
}
/** Why a project's agent runtime could not be started. An empty model catalog
 * is a symptom with many causes; this carries the cause itself so the UI can
 * state it instead of guessing that the backend is down. */
export interface RuntimeUnavailableReport {
  projectId: string;
  cwd: string;
  /** Error `code` the failure carried (`unavailable`, `restart-deferred`, …). */
  code: string;
  message: string;
  /** Locations checked while looking for the OpenCode CLI, when the failure
   * was a lookup. Absent for every other kind of failure. */
  searched?: string[];
  /** Consecutive failures since this runtime was last usable. */
  attempts: number;
  firstFailedAt: string;
  lastFailedAt: string;
}
export interface RuntimeDiagnosticsDto {
  /** True when every known runtime is usable. */
  ok: boolean;
  runtimes: RuntimeUnavailableReport[];
}
export interface RuntimeSession {
  id: string;
  title: string;
  parentId?: string;
  createdAt: number;
  updatedAt: number;
  /** Present only when the protocol supplies a stable create-operation
   * receipt. Used to recover an unknown create without issuing another POST. */
  operationId?: string;
}
export interface RuntimeSessionMessage { role: "user" | "assistant"; text: string; reasoning?: string }

export interface CanonicalTurnRequest {
  sessionId: string;       // canonical session id; adapter maps to backend id
  text: string;
  command?: { id: string; owner: "native"; name: string; args?: string };
  /** Already persisted in the user/message event before startTurn is called. */
  attachments?: AttachmentRef[];
  model?: ModelRef;
  agent?: string;
}

/** A stateless, small-model completion.  Unlike a turn this has no canonical
 * session, no tools, and no event stream to persist.  It is deliberately
 * optional on AgentRuntime so adapters which cannot safely address a provider
 * directly can retain the session-backed compatibility path. */
export interface SmallModelCompletionRequest {
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  model?: ModelRef;
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** A provider-neutral JSON-schema-shaped value. Providers may decline it. */
  responseSchema?: JsonObject;
}

export interface SmallModelCompletionResult {
  text: string;
  providerID: string;
  modelID: string;
  inputTruncated: boolean;
  transport: "direct" | "compatibility";
  latencyMs: number;
  firstTokenMs?: number;
}

/** Provider-neutral exact-history branch request (UX-MSG-ACTIONS).
 *  `sourceSessionId` and `target.sessionId` are canonical ids; the server
 *  passes only the canonical effective model history and never knows a
 *  backend message id. When `target.sessionId === sourceSessionId` the
 *  adapter prepares a replacement backend for the same canonical session and
 *  swaps its mapping only after the exact prefix is verified. */
export interface RuntimeBranchRequest {
  sourceSessionId: string;
  target: CreateSessionInput & { sessionId: string; cwd: string };
  history: ModelMessage[];
}

// Runtime events the adapter yields; session service translates + persists them.
export type RuntimeEvent =
  | { type: "turn/started"; turnId: string; model?: ModelRef }
  | { type: "session/title-generated"; title: string }
  | { type: "assistant/chunk"; partId: string; text: string }
  | { type: "assistant/reasoning-chunk"; partId: string; text: string }
  | { type: "assistant/message"; partId: string; text: string; reasoning?: string; tokens?: TokenUsage; cost?: number }
  | { type: "tool/call"; callId: string; tool: string; input: JsonObject; status: "pending" | "running" }
  | { type: "tool/started"; callId: string; tool: string; input: JsonObject }
  | { type: "tool/result"; callId: string; tool: string; output: string; title?: string; metadata?: JsonObject; input?: JsonObject }
  | { type: "tool/error"; callId: string; tool: string; error: string; input?: JsonObject }
  | { type: "permission/requested"; requestId: string; permission: string; patterns: string[]; metadata?: JsonObject; tool?: string }
  | { type: "question/asked"; requestId: string; questions: JsonObject[] }
  | ({ type: "secret/requested" } & SecretRequestData)
  | { type: "session/compacted"; backendEventId?: string }
  | { type: "compaction/part-recorded"; partId: string; messageId?: string; auto?: boolean }
  | ({ type: "context/updated" } & ContextWindowState)
  | { type: "runtime/commands-changed"; commands: RuntimeCommandDescriptor[] }
  | { type: "turn/stopped"; turnId?: string; reason: "completed" | "aborted" | "error"; error?: string; code?: RuntimeErrorCode; retry?: RateLimitRetryHint }
  | ({ type: "usage/recorded" } & UsageRecordedData)
  // Full revisioned snapshots (WP8): replay-deterministic task/subagent state.
  | { type: "task/snapshot"; listId: string; revision: number; items: Array<{ id: string; text: string; status: TaskItemStatus }> }
  | { type: "subagent/snapshot"; revision: number; agents: Array<{ sessionId: string; label: string; status: string; currentTask?: string }> };

export interface AgentRuntime {
  readonly harnessId?: string;
  /** Positive proof that THIS backend session on THIS authority generation can
   * no longer continue the previous execution. Abort acknowledgement is not
   * sufficient. Unknown is never permission to start a target. Must remain
   * idempotently re-verifiable for the supplied binding incarnation. */
  releaseExecution?(binding: RuntimeSessionBinding, operationId: string): Promise<MutationOutcome<ExecutionReleaseProof>>;
  capabilities(): Promise<RuntimeCapabilities>;
  models(): Promise<ModelDescriptor[]>;
  agents(): Promise<AgentDescriptor[]>;
  /** Every provider the backend currently exposes (id + name only) — for the
   *  "add a provider" picker. Optional: legacy backends may not support it. */
  listAllProviders?(): Promise<AvailableProviderDescriptor[]>;
  /** Special login flows registered per provider id. Absence means discovery
   *  could not list methods — it is not an invitation to invent an API key. */
  providerAuthMethods?(): Promise<Record<string, ProviderAuthMethod[]>>;
  /** Start a provider's OAuth flow; `inputs` answers that method's prompts. */
  providerAuthorize?(
    providerID: string,
    method: number,
    inputs?: Record<string, string>,
  ): Promise<ProviderAuthorization>;
  /** Complete OAuth. `code` is omitted for auto/device flows whose callback
   * blocks while the user finishes browser authentication. */
  providerAuthCallback?(providerID: string, method: number, code?: string): Promise<boolean>;
  /** Store a plain API key (plus any extra prompt answers) for a provider. */
  setProviderApiKey?(providerID: string, key: string, metadata?: Record<string, string>): Promise<boolean>;
  /** Persist OpenCode Auth.Info (api or wellknown). Secret values never return. */
  setProviderAuth?(providerID: string, info: ProviderAuthWrite): Promise<boolean>;
  /** Revoke stored credentials for a provider. */
  removeProviderAuth?(providerID: string): Promise<boolean>;
  ensureSession(canonical: CreateSessionInput & { sessionId: string; cwd: string }): Promise<string>;
  /** Operation-aware create. The supplied durable ID is used for this one
   * attempt and ambiguity is returned instead of hidden replay. */
  createSessionOperation?(
    canonical: CreateSessionInput & { sessionId: string; cwd: string },
    operationId: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>>;
  /** Replace one canonical session's backend history with a fresh backend session. */
  resetSession?(canonical: CreateSessionInput & { sessionId: string; cwd: string }): Promise<string>;
  resetSessionOperation?(
    canonical: CreateSessionInput & { sessionId: string; cwd: string },
    operationId: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>>;
  /** Create a backend session holding EXACTLY the requested canonical history
   *  (native fork at the exact predecessor). Returns the backend child id.
   *  Rejects `history-mismatch` when the read-back child history differs and
   *  `unsupported` when the runtime cannot branch or hydrate exact history —
   *  never approximates with a hidden prompt, summary, or optimistic copy. */
  branchSession?(request: RuntimeBranchRequest): Promise<string>;
  branchSessionOperation?(
    request: RuntimeBranchRequest,
    operationId: string,
  ): Promise<MutationOutcome<{ backendSessionId: string }>>;
  /** Best-effort discard of an unreferenced backend branch after a failed
   *  canonical publication. Never throws for an unknown session. */
  discardSession?(sessionId: string): Promise<void>;
  discardSessionOperation?(
    sessionId: string,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  sessions(): Promise<RuntimeSession[]>;
  history(sessionId: string): Promise<RuntimeSessionMessage[]>;
  startTurn(req: CanonicalTurnRequest): Promise<void>; // events flow via onEvent
  startTurnOperation?(
    req: CanonicalTurnRequest,
    operationId: string,
  ): Promise<MutationOutcome<{ admissionId?: string }>>;
  /** Direct stateless provider request for lightweight utility inference.
   * Implementations must not create a backend session. */
  completeSmallModel?(request: SmallModelCompletionRequest): Promise<SmallModelCompletionResult>;
  /** Live steering of an active turn. A supplied model/agent applies to this
   *  steering prompt, so changing providers does not silently retain the
   *  active turn's old selection. Returns false when unsupported/rejected;
   *  callers must fall back to queueing. Optional so old fakes remain valid. */
  steer?(sessionId: string, text: string, model?: ModelRef, agent?: string): Promise<boolean>;
  steerOperation?(
    sessionId: string,
    text: string,
    operationId: string,
    model?: ModelRef,
    agent?: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  abort(sessionId: string): Promise<void>;
  abortOperation?(
    sessionId: string,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  replyPermission(sessionId: string, requestId: string, reply: "once" | "always" | "reject"): Promise<void>;
  replyPermissionOperation?(
    sessionId: string,
    requestId: string,
    reply: "once" | "always" | "reject",
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  replyQuestion(sessionId: string, requestId: string, answers: JsonObject): Promise<void>;
  replyQuestionOperation?(
    sessionId: string,
    requestId: string,
    answers: JsonObject,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  replySecret?(sessionId: string, requestId: string, result: SecretResolvedData): Promise<void>;
  replySecretOperation?(
    sessionId: string,
    requestId: string,
    result: SecretResolvedData,
    operationId: string,
  ): Promise<MutationOutcome<Record<string, never>>>;
  endpoint?(): Promise<RuntimeEndpoint>;
  protocol?(): Promise<ProtocolAdapter["protocol"]>;
  reconcile?(
    binding: RuntimeReconciliationBinding,
    after?: string,
  ): Promise<RuntimeSnapshot>;
  /** Present on runtimes that can preserve semantic upstream identity. When a
   * consumer subscribes here, identified events are delivered through this
   * seam instead of the legacy unindexed onEvent path. */
  onObservation?(cb: (sessionId: string, observation: RuntimeObservation) => void): Disposable;
  onLifecycle?(cb: (notification: RuntimeLifecycleNotification) => void): Disposable;
  onEvent(cb: (sessionId: string, ev: RuntimeEvent) => void): Disposable;
  /** Native slash-command catalog for this session, when discovery is supported. */
  commands?(sessionId: string): Promise<RuntimeCommandDescriptor[]>;
  /** Request context compaction when the runtime exposes a real API. */
  compact?(sessionId: string, model?: ModelRef): Promise<void>;
  compactOperation?(
    sessionId: string,
    operationId: string,
    model?: ModelRef,
  ): Promise<MutationOutcome<Record<string, never>>>;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------- tools & permissions

export interface ToolDefinition {
  name: string; description: string;
  inputSchema: JsonObject;      // JSON schema
  trust: TrustClass;
  /** Namespaced contribution id when this tool is package-published. */
  id?: string;
  mutating?: boolean;
}
export interface ToolExecutionContext {
  sessionId: string;
  projectId: string;
  cwd: string;
  signal?: AbortSignal;
  /** Grant Space. Handlers must not trust a model-supplied space id. */
  spaceId?: string;
}
export type ToolExecutor = (input: JsonObject, ctx: ToolExecutionContext) => Promise<{ output: string; metadata?: JsonObject }>;

export type ToolGuardVerdict =
  | { kind: "abstain" }
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "require-approval"; request: PermissionRequestData };

export interface PermissionGuard {
  id: string;
  check(call: { tool: string; input: JsonObject; sessionId: string; projectId: string }): Promise<ToolGuardVerdict> | ToolGuardVerdict;
}

// ---------------------------------------------------------------- projects

export interface ProjectDefaults {
  agentProfileId?: string | null;
  /** null/absence inherits global Auto ordering. */
  harness?: HarnessSelection | null;
  agent?: string | null;
  /** null explicitly inherits the browser's global session default. */
  model?: ModelRef | null;
  /** Persist composer model choices as this project's default. */
  rememberModelSelection?: boolean;
  groupingMode?: string;
  worktreeBehavior?: "project-root" | "fresh-worktree";
}

/** Binding of a project to a workspace on a remote machine. When present,
 * `Project.path` is the path ON that machine and the agent runtime runs there
 * (see `RemoteHost`); local filesystem features degrade honestly. */
export interface ProjectRemote {
  kind: "ssh";
  /** SSH connection id from the SSH connection inventory. */
  connectionId: string;
}

export interface Project {
  id: string; path: string; name: string;
  /** Owning Space. Absent only on records written before tenancy shipped;
   *  the boot migration backfills them into the default Space. */
  spaceId?: string;
  color?: string; icon?: string; createdAt: number;
  defaults?: ProjectDefaults;
  labelIds?: string[];
  remote?: ProjectRemote;
}

/** Agent-oriented project inventory with session activity counts. */
export interface AgentProjectSummaryDto {
  project: Project;
  sessionCount: number;
  activeSessionCount: number;
  archivedSessionCount: number;
  latestActivityAt?: number;
}

/** One cross-project session inventory row with a bounded recent event tail. */
export interface AgentSessionSummaryDto {
  session: SessionProjection;
  project: Project | null;
  eventCount: number;
  latestSeq: number;
  recentEvents: SessionEvent[];
}

export interface AgentSessionListDto {
  projects: AgentProjectSummaryDto[];
  sessions: AgentSessionSummaryDto[];
  total: number;
  limit: number;
  offset: number;
}

/** Complete agent read model: canonical projection, conversation, state, and
 * a bounded event window. The dedicated events endpoint pages the full log. */
export interface AgentSessionDetailDto {
  session: SessionProjection;
  project: Project | null;
  events: SessionEvent[];
  messages: ModelMessage[];
  state: SessionDebugDto;
  eventWindow: {
    total: number;
    returned: number;
    truncatedBeforeSeq?: number;
  };
  links: Record<string, string>;
}

export interface ProjectPatch {
  name?: string;
  color?: string;
  icon?: string;
  defaults?: ProjectDefaults;
}

/** Presentation-only state shared by every client of one project. The web
 * client owns the schema of each value; the server only bounds the known keys
 * and stores the JSON record beside its project. */
export const PROJECT_PRESENTATION_SETTING_KEYS = [
  "widgetLayout",
  "workspacePanel",
  "workspacePane",
  "workbenchLayout",
  "capabilityLayout",
  "workspaceMode",
] as const;
export type ProjectPresentationSettingKey = typeof PROJECT_PRESENTATION_SETTING_KEYS[number];

export interface ProjectPresentationSettingsDto {
  revision: number;
  updatedAt: number;
  settings: Partial<Record<ProjectPresentationSettingKey, JsonValue>>;
}

/** Clone a GitHub/GitLab repository on the current Polyth host or an SSH host. */
export interface ProjectCloneInput {
  repository: string;
  parentPath: string;
  name?: string;
  remote?: ProjectRemote;
}

export interface ProjectService {
  list(): Promise<Project[]>;
  add(path: string, name?: string): Promise<Project>;
  create(path: string, name?: string): Promise<Project>;
  /** Clone a Git repository into a new child of `parentPath`, then register it. */
  clone?(repository: string, parentPath: string): Promise<Project>;
  remove(id: string): Promise<void>;
  get(id: string): Promise<Project | undefined>;
  /** PATCH metadata/defaults; optional so old fakes remain valid. */
  update?(id: string, patch: ProjectPatch): Promise<Project>;
  /** Presentation-only layout state, isolated with the project scope. */
  getPresentationSettings?(id: string): Promise<ProjectPresentationSettingsDto>;
  putPresentationSettings?(
    id: string,
    settings: Record<string, unknown>,
  ): Promise<ProjectPresentationSettingsDto>;
  /** Register a project whose path lives on a remote machine — the local
   *  existence check does not apply. Optional so old fakes remain valid. */
  addRemote?(path: string, remote: ProjectRemote, name?: string): Promise<Project>;
}

// ---------------------------------------------------------------- packages

export type PackageSettingsGroup = "Workspace" | "Engineering" | "Customize" | "System";

export interface PackageDescriptorDto {
  id: string;
  name: string;
  description: string;
  core: boolean;
  enabled: boolean;
  status?: "ready" | "disabled";
  settingsGroup?: PackageSettingsGroup;
  /** Emoji or short icon label for the settings navigation. */
  icon?: string;
  hasSettings: boolean;
}

// ------------------------------------------------ package onboarding tours

/** Visual for a tour step: either a real screenshot (`kind: "image"` + `src`)
 * or a named decorative pattern (`kind: "pattern"` + `pattern`) the web app
 * draws itself, so tours need no bundled assets. */
export interface PackageOnboardingMedia {
  kind: "image" | "pattern";
  /** Image URL, required when kind is "image". */
  src?: string;
  /** Pattern key (e.g. "branches", "waveform", "tiles", "orbit", "rays"),
   * used when kind is "pattern". Unknown keys fall back to a typographic
   * treatment of the tour title. */
  pattern?: string;
}

/** Where a step's highlighted control lives, so the overlay can caption it
 * honestly ("In these settings" vs "In the workspace pane" etc.). */
export type PackageOnboardingHighlightWhere =
  | "settings"
  | "workspace"
  | "pane"
  | "composer"
  | "header";

export interface PackageOnboardingStep {
  id: string;
  title: string;
  /** Short plain-text copy; a sentence or two per step. */
  body: string;
  /** Exact UI label of the control this step explains, if any. */
  highlight?: string;
  /** Location of the highlighted control. Defaults to "settings". */
  highlightWhere?: PackageOnboardingHighlightWhere;
  media?: PackageOnboardingMedia;
}

/** A package's multi-step introduction overlay. Tours are registered
 * client-side (by the package installer or the built-in tour list) and shown
 * over the settings modal; skip/complete flags are pure UI preference state
 * and never enter the session event log. */
export interface PackageOnboardingTour {
  packageId: string;
  title: string;
  steps: PackageOnboardingStep[];
}

// ---------------------------------------------------------------- Home Assistant

export interface HomeAssistantEntitySelection {
  stateEntityId: string;
  lightEntityId: string;
  climateEntityId: string;
  sensorEntityIds: string[];
}

/** Safe, browser-visible settings. `tokenEnv` is a reference; token values are
 * write-only and never appear in this shape. */
export interface HomeAssistantConfigDto {
  baseUrl: string;
  tokenEnv: string;
  tokenConfigured: boolean;
  entities: HomeAssistantEntitySelection;
}

export interface HomeAssistantConfigInput {
  baseUrl?: string;
  tokenEnv?: string;
  /** Write-only long-lived access token. */
  token?: string;
  entities?: Partial<HomeAssistantEntitySelection>;
}

export interface HomeAssistantConnectionDto {
  status: "connected" | "unconfigured" | "unavailable";
  baseUrl: string;
  checkedAt: number;
  version?: string;
  message?: string;
}

export interface HomeAssistantEntityDto {
  entityId: string;
  state: string;
  attributes: Record<string, JsonValue>;
  lastChanged: string;
  lastUpdated: string;
}

// ---------------------------------------------------------------- SSH remotes

/** How the OpenSSH client authenticates. Password auth is intentionally not
 * supported: Polyth delegates authentication to the user's OpenSSH setup
 * (agent, default keys, ssh_config) or an explicit identity FILE PATH — no
 * secret material is ever stored or returned. */
export type SshAuthMode = "agent" | "identity-file";

export interface SshConnectionDto {
  id: string;
  name: string;
  /** Hostname, IP, or an ssh_config Host alias. */
  host: string;
  port?: number;
  user?: string;
  authMode: SshAuthMode;
  /** Private-key path on the LOCAL machine (never key content). */
  identityFile?: string;
  createdAt: number;
}

export interface SshConnectionInput {
  name?: string;
  host?: string;
  port?: number;
  user?: string;
  authMode?: SshAuthMode;
  identityFile?: string;
}

export type SshConnectionState = "connected" | "disconnected" | "unreachable" | "auth-failed";

export interface SshConnectionStatusDto {
  id: string;
  state: SshConnectionState;
  checkedAt: number;
  /** Round-trip time of the last real probe (test), not of mux checks. */
  latencyMs?: number;
  message?: string;
}

export interface SshBrowseEntryDto { name: string; path: string }
export interface SshBrowseDto {
  path: string;
  parent: string | null;
  home: string;
  entries: SshBrowseEntryDto[];
}

/** Generic transport to a machine reachable over an established connection.
 * Implemented by the SSH feature package and consumed by backend-opencode to
 * run the agent runtime ON the remote host — the transport itself knows
 * nothing about OpenCode. */
export interface RemoteProcessHandle {
  /** Combined stdout+stderr of the remote process, as it streams in. */
  onOutput(cb: (chunk: string) => void): Disposable;
  onExit(cb: (code: number | null) => void): Disposable;
  /** Input for an interactive remote process, when the host supports it.
   * Resolves only after the local transport accepts the write; rejects when
   * the process has exited or its input channel can no longer accept data. */
  write?(data: string): Promise<void>;
  /** Best-effort termination of the remote process. */
  kill(): Promise<void>;
}

export interface RemoteForwardHandle extends Disposable {
  localPort: number;
}

export interface RemoteHost {
  /** Human-readable identity for error messages (e.g. "user@host"). */
  label: string;
  /** Run a command to completion (bounded output, POSIX sh on the far side). */
  exec(
    command: string,
    opts?: { timeoutMs?: number; maxOutputBytes?: number },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Start a long-lived remote process whose output can be observed. `stdin`
   * requests a raw non-TTY input pipe for programmatic secrets or protocols. */
  start(command: string, opts?: { interactive?: boolean; stdin?: "pipe" }): Promise<RemoteProcessHandle>;
  /** Forward a fresh local port to `remotePort` on the remote loopback. */
  forward(remotePort: number): Promise<RemoteForwardHandle>;
}

// ---------------------------------------------------------------- task trackers

export type TaskTrackerProvider = "jira" | "trello";
export type TaskTrackerProviderMode = "live" | "demo";
export type TaskTrackerBoardType = "kanban" | "scrum" | "simple" | "unknown";
export type TaskTrackerStatusCategory = "todo" | "in_progress" | "done" | "unknown";

export interface TaskTrackerProviderDto {
  provider: TaskTrackerProvider;
  /** Live uses configured credentials; demo is an in-memory credential-free sandbox. */
  mode: TaskTrackerProviderMode;
  configured: boolean;
  /** Environment-variable names only. Credential values are never returned. */
  requiredEnv: string[];
}

export interface TaskTrackerProjectDto {
  provider: TaskTrackerProvider;
  id: string;
  key: string;
  name: string;
  url?: string;
  avatarUrl?: string;
}

export interface TaskTrackerBoardDto {
  provider: TaskTrackerProvider;
  id: string;
  name: string;
  type: TaskTrackerBoardType;
  projectId?: string;
  projectKey?: string;
  url?: string;
}

export interface TaskTrackerStatusDto {
  id: string;
  name: string;
  category: TaskTrackerStatusCategory;
}

export interface TaskTrackerTaskDto {
  provider: TaskTrackerProvider;
  id: string;
  key: string;
  title: string;
  description: string;
  url?: string;
  boardId?: string;
  projectId?: string;
  projectKey?: string;
  status: TaskTrackerStatusDto;
  availableStatuses?: TaskTrackerStatusDto[];
  labels: string[];
  assignees: string[];
  dueAt?: string;
  updatedAt?: string;
}

export interface TaskTrackerTaskQuery {
  boardId?: string;
  projectId?: string;
  limit?: number;
}

/** Durable task-link projection returned for one Polyth session. */
export interface TaskTrackerSessionTaskDto {
  provider: TaskTrackerProvider;
  taskId: string;
  taskKey: string;
  title: string;
  statusId: string;
  statusName: string;
  completed: boolean;
  selectedAtSeq: number;
  updatedAtSeq: number;
}

export interface TaskTrackerService {
  providers(): TaskTrackerProviderDto[];
  listProjects(provider: TaskTrackerProvider): Promise<TaskTrackerProjectDto[]>;
  listBoards(provider: TaskTrackerProvider, projectId?: string): Promise<TaskTrackerBoardDto[]>;
  listTasks(provider: TaskTrackerProvider, query: TaskTrackerTaskQuery): Promise<TaskTrackerTaskDto[]>;
  getTask(provider: TaskTrackerProvider, taskId: string): Promise<TaskTrackerTaskDto>;
  updateStatus(
    provider: TaskTrackerProvider,
    taskId: string,
    statusId: string,
  ): Promise<TaskTrackerTaskDto>;
}

export interface TaskSelectedData {
  provider: TaskTrackerProvider;
  taskId: string;
  taskKey: string;
  title: string;
  url?: string;
  statusId: string;
  statusName: string;
}

export interface TaskStatusChangedData extends TaskSelectedData {
  previousStatusId: string;
  previousStatusName: string;
}

export interface TaskCompletedData extends TaskSelectedData {}

// ---------------------------------------------------------------- UI contributions (host + client shared shapes)

/** Canonical slot vocabulary — the runtime list backs `UiSlot` so the
 *  server-managed manifest boundary can reject unknown slot names. */
export const UI_SLOTS = [
  "app.nav", "app.header.actions", "app.window.controls", "session.header.actions", "session.header.status", "session.list.badges",
  "sidebar.footer",
  "composer.leading", "composer.execution", "composer.trailing", "modelPicker.header", "contextRail.tabs",
  "settings.pages", "settings.footer", "settings.integrations", "commandPalette.commands",
  "git.repository.identity", "git.repository.identity.provider", "git.change-request.create", "git.repository.change-request.provider", "project.repository.options",
  // Widget definitions enter through the catalog/settings seams. The six
  // workspace slots are first-class placement targets alongside panel and
  // toolbar slots, rather than a canvas-only parallel vocabulary.
  "widget.catalog", "widget.settings", "workspace.canvas",
  "workspace.header", "workspace.left", "workspace.main",
  "workspace.right", "workspace.bottom", "workspace.floating",
  // parity slots (WP1): focused seams instead of mega-component imports
  "workspace.main.tabs", "workspace.right.tabs",
  // Widget-areas (WA1): every shell region the layout engine can host widgets
  // in is a named area. `workspace.rail` is the right icon rail (replaces the
  // capability-tier rails); the header/sidebar/composer rows are fine-grained
  // toolbars the Widget Library can target directly.
  "app.header.leading", "app.header.center", "workspace.rail",
  "sidebar.toolbar", "composer.meta", "composer.pending",
  // project creation sources beyond the local folder picker (e.g. SSH remotes)
  "project.create.options",
  "session.timeline.before", "session.timeline.event", "session.timeline.after", "session.composer.before",
  "settings.harness.detail",
  "session.footer",
  // Fresh-session widgets (starters, recents, or a plugin replacement). This
  // is deliberately a slot rather than a SessionHero import: idle-screen
  // information density is user-configurable and plugins can replace it.
  "session.empty.widgets",
  "session.message.actions",
  "sidebar.project.actions", "sidebar.session.actions",
  "workStatus.sections",
] as const;

export type UiSlot = (typeof UI_SLOTS)[number];

export function isUiSlot(value: string): value is UiSlot {
  return (UI_SLOTS as readonly string[]).includes(value);
}

/** Canonical locale vocabulary — every message catalog covers all of these. */
export const LOCALES = [
  "uk", "en", "de", "fr", "pl", "pt-BR", "it", "es", "zh-CN", "bg", "ar", "pt",
] as const;

export type Locale = (typeof LOCALES)[number];

/** Per-locale message catalogs a package contributes; the web app merges the
 *  bundles from every package into one catalog per locale. English is the
 *  canonical key set — `K` is derived from a package's `en` catalog so a
 *  missing or extra key in any locale fails the typecheck. */
export type LocaleBundle<K extends string = string> = Record<Locale, Record<K, string>>;

export type WidgetKind = "widget" | "mini-widget";
export type WidgetAudience = "simple" | "standard" | "power";
export type WidgetScope = "global" | "workspace" | "plugin";
export type PanelItemSize = "compact" | "standard" | "wide" | "large";

export interface WidgetSize {
  w: number;
  h: number;
}

/** Serializable half of a plugin-owned widget. The client pairs `module` with
 * an allowlisted renderer. A plugin may declare zero, one, or many of these.
 * Full widgets and toolbar/panel actions share this contribution shape; `kind`
 * only controls host sizing/chrome. */
export interface WidgetContributionDescriptor {
  id: string;
  module: string;
  title: string;
  description: string;
  kind: WidgetKind;
  defaultSlot: UiSlot;
  supportedSlots: UiSlot[];
  order?: number;
  category?: string;
  capabilities?: string[];
  /** Preferred size for a newly added widget. It is guidance, not a resize
   * constraint: users may shrink the widget below this size afterward. */
  recommendedSize?: WidgetSize;
  defaultSize?: WidgetSize;
  minSize?: WidgetSize;
  maxSize?: WidgetSize;
  audience?: WidgetAudience;
  showIn?: WidgetAudience[];
  scope?: WidgetScope;
  resizable?: boolean;
  duplicatable?: boolean;
  recommended?: boolean;
  defaultVisible?: boolean;
  panelSizes?: PanelItemSize[];
  panelDefaultSize?: PanelItemSize;
  panelTitle?: string;
  /** JSON Schema-shaped, browser-visible per-instance settings metadata. */
  settingsSchema?: JsonObject;
}

export interface UiSlotItem {
  id: string;
  slot: UiSlot;
  order?: number;
  module: string;             // lazy client module key resolved by the shell
  props?: JsonObject;
  requiresCapabilities?: string[];
  platforms?: Array<"web" | "desktop" | "vscode" | "mobile">;
}

export interface UiContributionRegistry {
  addSlot(item: UiSlotItem): Disposable;
  list(slot: UiSlot): UiSlotItem[];
}

// ---------------------------------------------------------------- plugin runtime

export type TrustClass = "ui-only" | "pure" | "workspace" | "network" | "device" | "privileged" | "credentialed";

export interface PluginManifest {
  id: string;
  version: string;
  trust: TrustClass;
  provides?: string[];        // capability ids
  requires?: string[];
  optionalRequires?: string[];
  /** Optional UI surface. Omitted/empty means this plugin has no widgets. */
  widgets?: WidgetContributionDescriptor[];
}

export interface PluginContext {
  provide<T>(key: CapabilityKey<T>, value: T, priority?: number): Disposable;
  inject<T>(key: CapabilityKey<T>): T;                     // throws if missing
  optional<T>(key: CapabilityKey<T>): T | undefined;
  on(event: string, cb: (payload: never) => void): Disposable;
  emit(event: string, payload: JsonObject): void;
  waterfall<T>(event: string, value: T): Promise<T>;       // serial reduce through listeners
  effect(disposer: () => void | Promise<void>): void;      // owned by plugin scope
  contribute(item: UiSlotItem): Disposable;
  config<T = JsonObject>(): T;
  scope(
    id: string,
    opts?: { config?: JsonObject; capabilities?: Array<CapabilityKey<unknown>> },
  ): PluginContext;                                        // child scope
  log(level: "debug" | "info" | "warn" | "error", msg: string, data?: JsonObject): void;
}

export interface Plugin<TConfig = JsonObject> {
  manifest: PluginManifest;
  setup(ctx: PluginContext, config: TConfig): void | Promise<void>;
}

// ---------------------------------------------------------------- terminal (M3)

export interface TerminalCreateInput {
  projectId: string;
  /** override cwd; defaults to the project path (UI passes a session's worktreePath here) */
  cwd?: string;
  /** command to run; omitted = interactive shell */
  cmd?: string;
  /** when set, terminal/created|closed events are appended to this session's log */
  sessionId?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  projectId: string;
  createdAt: number;
  running: boolean;
  /** Set once the process has exited (F12: exited-but-not-closed terminals stay listed). */
  exitCode?: number | null;
}

export interface TerminalCreatedData {
  terminalId: string;
  projectId: string;
  cwd: string;
  cmd?: string;
}

export interface TerminalClosedData {
  terminalId: string;
  projectId: string;
  exitCode: number | null;
}

// ================================================================ parity contracts (WP1)
// All additions below are optional/additive: old event logs, JSON stores and
// clients keep working; unknown events stay ignorable.

// ---------------------------------------------------------------- delivery & queue (WP3)

export type DeliveryMode = "normal" | "steer" | "queue" | "interrupt";

export interface QueueItemDto {
  id: string;
  sessionId: string;
  position: number;
  text: string;
  delivery: DeliveryMode;
  createdAt: number;
  /** Preserved across queueing so deferred sends keep their attachments. */
  attachments?: AttachmentRef[];
  /** Preserved so a deferred native command cannot degrade into prompt text. */
  command?: { id: string; args?: string };
  /** Preserve retry/regeneration presentation semantics through deferred delivery. */
  hiddenUserMessage?: boolean;
  /** A fenced prior-epoch admission is a draft for explicit review, never dispatchable. */
  heldForReview?: boolean;
}

export interface QueueEnqueuedData { queueId: string; text: string; delivery: string; hiddenUserMessage?: boolean }
export interface QueueDispatchedData { queueId: string }
export interface QueueEditedData { queueId: string; text: string }
export interface QueueReorderedData { ids: string[] }
export interface QueueRemovedData { queueId: string }
export interface DeliverySteeredData { text: string }
export interface DeliveryFallbackQueuedData { queueId: string; reason: string }

export interface SendResult {
  turnId?: string;
  queueId?: string;
  queued?: boolean;
}

export interface ShellTurnResult {
  callId: string;
  status: "pending" | "completed" | "rejected";
  requestId?: string;
}

// ---------------------------------------------------------------- editor & files (WP4/WP6)

export interface EditorLocation { path: string; startLine?: number; endLine?: number; column?: number }

export interface FileStatDto {
  path: string;
  kind: "file" | "dir";
  size: number;
  mime?: string;
  revision?: string;
}

export type FileRenderKind = "text" | "markdown" | "html" | "json" | "binary";

// ---------------------------------------------------------------- tasks & subagents (WP8)

export type TaskItemStatus = "pending" | "active" | "done" | "failed";
export interface TaskSnapshotData {
  listId: string;
  revision: number;
  items: Array<{ id: string; text: string; status: TaskItemStatus }>;
}
export interface SubagentSnapshotData {
  revision: number;
  agents: Array<{ sessionId: string; label: string; status: string; currentTask?: string }>;
}

// ---------------------------------------------------------------- agent profiles (WP8)

export interface AgentProfile {
  id: string;
  name: string;
  /** Absent means a legacy profile whose origin is not known. */
  harnessId?: string;
  providerID: string;
  modelID: string;
  agent?: string;
  mode?: string;
  thinking?: string;
  features: Record<string, boolean>;
  notes?: string;
  icon?: string;
  color?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface AgentProfileSeed { harnessId?: string; providerID: string; modelID: string; name?: string }
export interface AgentProfileRepair { field: string; from: string; to: string; reason: string }

// ---------------------------------------------------------------- system info (WP9)

export interface SystemInfoDto {
  version: string;
  applicationUrl: string;
  tunnelUrl: string | null;
  dataDirLabel: string;
  capabilities: string[];
}

/** Server-persisted client preferences (Appearance, chat, notifications, …).
 *  The server treats `settings` as an opaque JSON object — the web client owns
 *  its schema (product settings + UI preferences). `revision` increments on
 *  every accepted write so clients can drop echoes of their own change and
 *  ignore stale WS broadcasts. */
export interface ClientSettingsDto {
  revision: number;
  updatedAt: number;
  settings: Record<string, unknown>;
}

// ---------------------------------------------------------------- folders & labels (WP5/WP18)

export interface SessionFolderDto {
  id: string;
  projectId: string;
  parentId?: string;
  name: string;
  position: number;
  revision: number;
}

export interface WorkspaceLabel {
  id: string;
  name: string;
  color: string;
  position: number;
  revision: number;
}

export interface BulkSessionResult {
  succeeded: string[];
  failed: Array<{ id: string; code: string }>;
}

// ---------------------------------------------------------------- pane surfaces (WP6)

export interface WorkspaceSurface {
  id: string;
  title: string;
  icon: string;
  placement: "main" | "right" | "either";
  singleton: boolean;
  keepAlive?: boolean;
  module: string;
  requiresCapabilities?: string[];
}

export interface PaneTabState {
  instanceId: string;
  surfaceId: string;
  resource?: string;
  title?: string;
  dirty?: boolean;
}

// ---------------------------------------------------------------- schedule cadence (WP10)

export type ScheduleCadence =
  | { kind: "at"; at: number }
  | { kind: "every"; everyMinutes: number }
  | { kind: "cron"; expression: string; timeZone: string };

export interface ScheduleTarget {
  mode: "existing-session" | "new-session-per-run" | "dedicated-session";
  sessionId?: string;
  worktreePolicy?: "project-root" | "fresh-worktree";
}

export type ScheduleOverlapPolicy = "skip" | "queue" | "parallel";

export interface ScheduleRunDto {
  runId: string;
  taskId: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "completed" | "failed" | "skipped";
  error?: string;
  sessionId?: string;
}

// ---------------------------------------------------------------- knowledge (WP10)

export type KnowledgeKind = "note" | "spec" | "plan" | "memory";
export interface KnowledgeItem {
  id: string;
  projectId: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  tags: string[];
  source: "user" | "agent" | "import";
  sourceSessionId?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface KnowledgeAttachedData {
  knowledgeId: string;
  revision: number;
  title: string;
  body: string;
  digest: string;
}

// ---------------------------------------------------------------- spec-driven tracks

export type TrackStatus = "draft" | "running" | "blocked" | "completed";
export type TrackStepStatus = "pending" | "running" | "failed" | "completed";

export interface TrackTestResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  /** Bounded tail of the test output. */
  output: string;
  completedAt: number;
}

export interface TrackStepDto {
  id: string;
  title: string;
  prompt: string;
  testCommand: string;
  commitMessage?: string;
  status: TrackStepStatus;
  sessionId?: string;
  scheduleTaskId?: string;
  startedAt?: number;
  completedAt?: number;
  commitSha?: string;
  test?: TrackTestResult;
  error?: string;
}

export interface TrackDto {
  id: string;
  projectId: string;
  title: string;
  status: TrackStatus;
  specKnowledgeId: string;
  planKnowledgeId: string;
  planRevision: number;
  steps: TrackStepDto[];
  currentStep: number;
  sessionId?: string;
  budgetTokens?: number;
  maxContinuations?: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface TrackStepInput {
  title: string;
  prompt?: string;
  testCommand: string;
  commitMessage?: string;
}

export interface TrackCreateInput {
  projectId: string;
  title: string;
  spec: string;
  steps: TrackStepInput[];
  budgetTokens?: number;
  maxContinuations?: number;
}

// ---------------------------------------------------------------- quotas (WP12)

export interface QuotaWindow {
  id: string;
  label: string;
  used: number;
  limit: number;
  unit: "tokens" | "requests" | "currency" | "percent";
  resetsAt?: number;
  periodMs?: number;
}

export interface QuotaSnapshot {
  providerId: string;
  accountLabel?: string;
  windows: QuotaWindow[];
  fetchedAt: number;
  stale: boolean;
  error?: { code: string; message: string };
}

export interface QuotaPace {
  usageFraction: number;
  timeFraction: number;
  pace: "under" | "on-track" | "over";
  predictedAtReset?: number;
  exhaustsAt?: number;
}

// ---------------------------------------------------------------- review & walkthrough (WP11)

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  path?: string;
  line?: number;
  body: string;
  confidence: number;
}
export interface ReviewAssessment {
  summary: string;
  findings: ReviewFinding[];
  riskScore: 1 | 2 | 3 | 4 | 5;
  confidenceScore: 1 | 2 | 3 | 4 | 5;
}

export type WalkthroughSource =
  | { kind: "working-tree"; projectId: string }
  | { kind: "range"; projectId: string; base: string; head: string }
  | { kind: "pull-request"; projectId: string; number: number };

export interface GeneratedWalkthroughStop {
  id: string;
  path: string;
  hunkDigest: string;
  diff: string;
  explanation: string;
}
export interface GeneratedWalkthroughStage {
  id: string;
  title: string;
  explanation: string;
  stops: GeneratedWalkthroughStop[];
}
export interface GeneratedWalkthroughDto {
  id: string;
  source: WalkthroughSource;
  sourceDigest: string;
  status: "queued" | "running" | "ready" | "failed";
  stages: GeneratedWalkthroughStage[];
  error?: string;
  createdAt: number;
}

export type CheckStatus =
  | "queued" | "in_progress" | "success" | "failure" | "cancelled"
  | "skipped" | "neutral" | "timed_out" | "action_required";
export interface PrCheck {
  id: string;
  name: string;
  workflow?: string;
  status: CheckStatus;
  startedAt?: string;
  completedAt?: string;
  url?: string;
  summary?: string;
}

export interface ReviewFlowState {
  id: string;
  sessionId: string;
  status: "idle" | "implementing" | "awaiting-review" | "reviewing" | "passed" | "changes-requested" | "failed" | "paused" | "stopped";
  iteration: number;
  maxIterations: number;
  baseDigest: string;
  latestReviewId?: string;
  stoppedReason?: string;
}

// ---------------------------------------------------------------- MCP & plugins (WP9)

export type McpTransport =
  | { kind: "stdio"; command: string; args: string[]; envKeys: string[] }
  | { kind: "http"; url: string; headersSecretRefs: string[] };

export type McpStatus = "disabled" | "starting" | "connected" | "error";

export interface McpServerDto {
  id: string;
  name: string;
  transport: McpTransport;
  enabled: boolean;
  status: McpStatus;
  lastError?: string;
  revision: number;
}

/** One entry in OpenCode's `plugin` config array. Tuple entries carry the
 * plugin's JSON-serializable options without exposing Polyth's managed-plugin
 * installation surface. */
export type OpenCodePluginConfigEntry = string | [string, JsonObject];

export interface OpenCodePluginEntryDto {
  spec: string;
  options?: JsonObject;
}

/** Pure paste-parser result used by the settings preview. */
export interface OpenCodePluginPreviewDto {
  entries: OpenCodePluginEntryDto[];
  errors: string[];
  /** Top-level config keys intentionally not imported in this v1 flow. */
  ignoredKeys: string[];
}

export interface OpenCodePluginListResponseDto {
  plugins: OpenCodePluginEntryDto[];
}

export interface OpenCodePluginImportRequestDto {
  plugins: OpenCodePluginConfigEntry[];
}

export interface OpenCodePluginImportResponseDto extends OpenCodePluginListResponseDto {
  imported: string[];
  pendingRestart: true;
}

export interface OpenCodePluginRemoveResponseDto extends OpenCodePluginListResponseDto {
  removed: boolean;
  pendingRestart: boolean;
}

export type OpenCodePendingChangeKind =
  | "agent"
  | "behavior"
  | "mcp"
  | "plugins"
  | "provider-visibility"
  | "provider-config"
  | "runtime-capabilities";

export interface OpenCodePendingChangeDto {
  id: string;
  kind: OpenCodePendingChangeKind;
  label: string;
}

export interface OpenCodePendingResponseDto {
  changes: OpenCodePendingChangeDto[];
  count: number;
}

export interface OpenCodeApplyRestartResponseDto {
  applied: number;
  restarted: number;
}

// ---------------------------------------------------------------- Secure Safe (OC-22-008)

export type SecureSafeKind = "env" | "token" | "password";
export type SecureSafeScope = "global" | "project";

/** Public metadata only. Secret values never cross this contract boundary. */
export interface SecureSafeEntryDto {
  id: string;
  handle: string;
  label: string;
  purpose: string;
  kind: SecureSafeKind;
  scope: SecureSafeScope;
  projectId?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SecureSafeManifest {
  version: number;
  handles: Array<{
    handle: string;
    label: string;
    purpose: string;
    kind: SecureSafeKind;
    envRef: string;
  }>;
}

export interface SecureSafeCreateInput {
  handle: string;
  label: string;
  purpose?: string;
  kind?: SecureSafeKind;
  scope?: SecureSafeScope;
  projectId?: string;
  value: string;
}

export interface SecureSafePatchInput {
  handle?: string;
  label?: string;
  purpose?: string;
  kind?: SecureSafeKind;
  scope?: SecureSafeScope;
  projectId?: string | null;
  /** Missing or blank retains the current write-only value. */
  value?: string;
}

export interface SecureSafeService {
  /** Replace known plaintext without exposing the values to callers. */
  redact?(text: string): string;
  list(): SecureSafeEntryDto[];
  manifest(): SecureSafeManifest;
  hasHandle(handle: string): boolean;
  create(input: SecureSafeCreateInput): Promise<SecureSafeEntryDto>;
  update(id: string, patch: SecureSafePatchInput): Promise<SecureSafeEntryDto>;
  remove(id: string): Promise<boolean>;
  upsertByHandle(input: SecureSafeCreateInput): Promise<SecureSafeEntryDto>;
  syncForbiddenConfig(): Promise<SecureSafeManifest>;
  /** Opaque host-owned secrets that never appear in list() or the Secure Safe UI. */
  putOpaque(key: string, value: string): void;
  getOpaque(key: string): string | null;
  deleteOpaque(key: string): void;
  deleteOpaqueByPrefix(prefix: string): void;
}

/** How a package's code executes. Bundled first-party packages are not
 *  represented here — they use the workspace discovery path. */
export type PackageRuntimeKind = "trusted-local" | "sandboxed";

export interface PackageCapabilityConstraintDto {
  origins?: string[];
}

export interface PackageCapabilityRequestDto {
  name: string;
  constraints?: PackageCapabilityConstraintDto;
}

export interface PackageCapabilityGrantDto {
  name: string;
  constraints?: PackageCapabilityConstraintDto;
  grantedAt: number;
  grantedBy?: string;
}

export interface PackageConnectionPublicDto {
  id: string;
  label: string;
  kind: "oauth" | "token";
  status: "disconnected" | "connecting" | "connected" | "error";
  account?: string;
  error?: string;
}

/** Browser-safe connection security fields. Never includes secrets. */
export interface PackageConnectionSecurityDto {
  kind: "oauth" | "token";
  origins: string[];
  authorizeUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  scopes?: string[];
}

export interface PackageConnectionReviewDto {
  id: string;
  label: string;
  kind: "new" | "changed";
  current?: PackageConnectionSecurityDto;
  next: PackageConnectionSecurityDto;
}

export interface PackagePermissionsDto {
  effective: string[];
  requested: PackageCapabilityRequestDto[];
  review?: {
    capabilities: PackageCapabilityRequestDto[];
    connections: PackageConnectionReviewDto[];
  };
}

export interface InstalledPluginDto {
  id: string;
  name: string;
  version: string;
  source: string;
  trust: TrustClass;
  enabled: boolean;
  status: "installed" | "loading" | "ready" | "error" | "disabled";
  update?: { version: string };
  contributions: UiSlotItem[];
  /** Widget declarations owned by this plugin; absent on older registries. */
  widgets?: WidgetContributionDescriptor[];
  /** Browser-safe URL and content hash for the install-time UI bundle. */
  ui?: { url: string; integrity: string };
  lastError?: string;
  runtimeKind?: PackageRuntimeKind;
  description?: string;
  icon?: string;
  previousVersion?: string;
  versions?: string[];
  permissions: PackagePermissionsDto;
  connections?: PackageConnectionPublicDto[];
  /** Sandboxed UI bootstrap (integrity-addressed). Absent for host-module UI. */
  sandbox?: { url: string; integrity: string };
}

// ---------------------------------------------------------------- browser (WP14)

export type BrowserColorScheme = "light" | "dark" | "no-preference";

export type BrowserViewportMode = "responsive" | "preset" | "custom";

export interface BrowserSessionDto {
  id: string;
  projectId: string;
  sessionId?: string;
  url: string;
  title: string;
  status: "starting" | "ready" | "closed" | "failed";
  viewport: { width: number; height: number; deviceScaleFactor: number };
  colorScheme: BrowserColorScheme;
  revision: number;
  /** honest engine state: "chromium" when driven, "unavailable" for fallback */
  engine: "chromium" | "fake" | "unavailable";
  /** Authoritative pause flag — never inferred from recency. */
  agentPaused?: boolean;
  /** Actor currently executing a queued action, if any. */
  controller?: "user" | "agent";
  /** How the current viewport was chosen. */
  viewportMode?: BrowserViewportMode;
}

/** Chat-workspace tabs are manual-only: no agent observation or extraction. */
export interface ContentAccessPolicy {
  contentAccess: "manual-only";
  agentControl: false;
  observation: false;
  contextCapture: false;
  inspect: false;
}

export type BrowserTarget =
  | { selector: string }
  | { text: string; exact?: boolean }
  | { role: string; name?: string; exact?: boolean }
  | { point: { x: number; y: number }; frameRevision: number };

export type BrowserAction =
  | { kind: "click"; target: BrowserTarget }
  /** Resolve the DOM element under a revisioned screenshot point without
   * interacting with it. Used by the user-facing element picker. */
  | { kind: "point"; target: Extract<BrowserTarget, { point: unknown }> }
  | { kind: "type"; target: BrowserTarget; text: string; submit?: boolean }
  | { kind: "press"; key: string }
  | { kind: "scroll"; x?: number; y?: number; target?: BrowserTarget }
  | { kind: "select"; target: BrowserTarget; value: string }
  | { kind: "wait"; condition: "network-idle" | "selector"; value?: string; timeoutMs?: number }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" }
  | { kind: "resize"; viewport: { width: number; height: number }; mode?: BrowserViewportMode }
  | { kind: "color-scheme"; colorScheme: BrowserColorScheme }
  | { kind: "inspect"; selector: string };

export interface BrowserObservation {
  url: string;
  title: string;
  text: string;
  accessibilityDigest?: string;
  screenshotRef?: string;
}

/** First-class browser context shared with the composer and agent (text-first). */
export type BrowserContextType = "page" | "element" | "area" | "text";

export interface BrowserContextBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserContextRegion {
  /** Normalized 0–1 rectangle relative to the captured frame. */
  normalized: { x: number; y: number; width: number; height: number };
  /** Pixel bounds in the browser viewport at capture time. */
  pixels: BrowserContextBounds;
}

export interface BrowserContextElementSummary {
  selector?: string;
  tag?: string;
  role?: string;
  name?: string;
  text?: string;
  attributes?: Record<string, string>;
  bounds?: BrowserContextBounds;
}

export interface BrowserContextArtifactRef {
  id: string;
  mime: string;
  size: number;
  /** Resolved absolute path filled server-side at verify time; never client-trusted. */
  localPath?: string;
}

/**
 * Durable browser context attached to a composer draft / user message.
 * Keep summaries bounded — never dump full DOM trees.
 */
export interface BrowserContext {
  id: string;
  type: BrowserContextType;
  browserSessionId: string;
  /** Project that owned the browser session at capture time. Recall and
   *  resend keep this provenance; they do not rebind it to the destination. */
  projectId: string;
  sessionId?: string;
  frameRevision: number;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  capturedAt: string;
  note?: string;
  quote?: string;
  region?: BrowserContextRegion;
  element?: BrowserContextElementSummary;
  intersecting?: BrowserContextElementSummary[];
  accessibilitySummary?: string;
  textSummary?: string;
  screenshot?: BrowserContextArtifactRef;
  crop?: BrowserContextArtifactRef;
  contentHash?: string;
}

/** Capture request; `id` is a stable client-generated identity for retries. */
export type BrowserContextCaptureInput =
  | {
    type: "page";
    id: string;
    expectedRevision: number;
    note?: string;
    includeScreenshot?: boolean;
  }
  | {
    type: "element";
    id: string;
    expectedRevision: number;
    point: { x: number; y: number };
    note?: string;
    includeScreenshot?: boolean;
  }
  | {
    type: "area";
    id: string;
    expectedRevision: number;
    /** Normalized 0–1 rectangle on the frame used for selection. */
    region: { x: number; y: number; width: number; height: number };
    note?: string;
    includeScreenshot?: boolean;
  }
  | {
    type: "text";
    id: string;
    expectedRevision: number;
    quote?: string;
    start?: { x: number; y: number };
    end?: { x: number; y: number };
    note?: string;
    includeScreenshot?: boolean;
  };

const BROWSER_CONTEXT_MIME = "application/vnd.polyth.browser-context+json";

/** Compact model-visible text. Screenshots stay optional evidence. */
export function formatBrowserContextForModel(ctx: BrowserContext): string {
  const lines: string[] = ["[Browser context]"];
  lines.push(`Type: ${ctx.type}`);
  lines.push(`URL: ${ctx.url}`);
  if (ctx.title) lines.push(`Page: ${ctx.title}`);
  lines.push(`Viewport: ${ctx.viewport.width}×${ctx.viewport.height}`);
  lines.push(`Frame revision: ${ctx.frameRevision}`);
  if (ctx.quote) lines.push(`Quote: ${ctx.quote}`);
  if (ctx.element) {
    const el = ctx.element;
    if (el.tag) lines.push(`Element: ${el.tag}`);
    if (el.role) lines.push(`Role: ${el.role}`);
    if (el.name) lines.push(`Accessible name: ${el.name}`);
    if (el.text) lines.push(`Text: ${el.text}`);
    if (el.selector) lines.push(`Selector: ${el.selector}`);
    if (el.bounds) {
      lines.push(
        `Bounds: x=${el.bounds.x}, y=${el.bounds.y}, width=${el.bounds.width}, height=${el.bounds.height}`,
      );
    }
    if (el.attributes && Object.keys(el.attributes).length > 0) {
      const attrs = Object.entries(el.attributes)
        .slice(0, 12)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ");
      lines.push(`Attributes: ${attrs}`);
    }
  }
  if (ctx.region) {
    const p = ctx.region.pixels;
    lines.push(`Area: ${p.width}×${p.height} at (${p.x}, ${p.y})`);
  }
  if (ctx.intersecting && ctx.intersecting.length > 0) {
    lines.push("Intersecting elements:");
    for (const el of ctx.intersecting.slice(0, 12)) {
      const label = [el.tag, el.role, el.name || el.text].filter(Boolean).join(" · ");
      lines.push(`- ${label || el.selector || "element"}`);
    }
  }
  if (ctx.textSummary) lines.push(`Visible text:\n${ctx.textSummary}`);
  if (ctx.accessibilitySummary) lines.push(`Accessibility:\n${ctx.accessibilitySummary}`);
  if (ctx.note) lines.push(`Note: ${ctx.note}`);
  return lines.join("\n");
}

/** English/model-facing label. UI copy is composed in the web layer. */
export function browserContextLabel(ctx: BrowserContext): string {
  if (ctx.type === "element") {
    const label = (ctx.element?.name || ctx.element?.text || ctx.element?.tag || "Element")
      .replace(/\s+/g, " ")
      .trim();
    return label.length > 48 ? `${label.slice(0, 47)}…` : label;
  }
  if (ctx.type === "area") return "Selected area";
  if (ctx.type === "text") {
    const quote = (ctx.quote || "").replace(/\s+/g, " ").trim();
    if (!quote) return "Selected text";
    return quote.length > 48 ? `${quote.slice(0, 47)}…` : quote;
  }
  const title = (ctx.title || hostPath(ctx.url) || "Page").replace(/\s+/g, " ").trim();
  return title.length > 48 ? `${title.slice(0, 47)}…` : title;
}

export function browserContextHostPath(url: string): string {
  return hostPath(url);
}

export function browserContextMime(): string {
  return BROWSER_CONTEXT_MIME;
}

function parseBounds(raw: unknown): BrowserContextBounds | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const b = raw as Record<string, unknown>;
  const x = Number(b.x);
  const y = Number(b.y);
  const width = Number(b.width);
  const height = Number(b.height);
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  return { x, y, width, height };
}

function parseElementSummary(raw: unknown): BrowserContextElementSummary | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  const selector = typeof e.selector === "string" ? e.selector : undefined;
  const tag = typeof e.tag === "string" ? e.tag : undefined;
  if (!selector && !tag) return undefined;
  const attributes = e.attributes && typeof e.attributes === "object" && !Array.isArray(e.attributes)
    ? Object.fromEntries(
      Object.entries(e.attributes as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"),
    )
    : undefined;
  const bounds = parseBounds(e.bounds);
  return {
    ...(selector ? { selector } : {}),
    ...(tag ? { tag } : {}),
    ...(typeof e.role === "string" ? { role: e.role } : {}),
    ...(typeof e.name === "string" ? { name: e.name } : {}),
    ...(typeof e.text === "string" ? { text: e.text } : {}),
    ...(attributes && Object.keys(attributes).length ? { attributes } : {}),
    ...(bounds ? { bounds } : {}),
  };
}

function parseArtifactRef(raw: unknown): BrowserContextArtifactRef | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== "string" || !a.id) return undefined;
  if (typeof a.mime !== "string" || !a.mime) return undefined;
  const size = Number(a.size);
  if (!Number.isSafeInteger(size) || size < 0) return undefined;
  return { id: a.id, mime: a.mime, size };
}

/** Fail-soft rebuild of a stored `BrowserContext`. Unknown keys and artifact
 *  `localPath` are dropped. Returns null when required fields are missing. */
export function parseBrowserContext(raw: unknown): BrowserContext | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== "string" || !c.id) return null;
  const type = c.type;
  if (type !== "page" && type !== "element" && type !== "area" && type !== "text") return null;
  if (typeof c.browserSessionId !== "string" || !c.browserSessionId) return null;
  if (typeof c.projectId !== "string" || !c.projectId) return null;
  const frameRevision = Number(c.frameRevision);
  if (!Number.isSafeInteger(frameRevision) || frameRevision < 0) return null;
  if (typeof c.url !== "string" || !c.url) return null;
  if (typeof c.title !== "string") return null;
  const viewportRaw = c.viewport && typeof c.viewport === "object" && !Array.isArray(c.viewport)
    ? c.viewport as Record<string, unknown>
    : null;
  const width = Number(viewportRaw?.width);
  const height = Number(viewportRaw?.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return null;
  if (typeof c.capturedAt !== "string" || !c.capturedAt) return null;
  const regionRaw = c.region && typeof c.region === "object" && !Array.isArray(c.region)
    ? c.region as Record<string, unknown>
    : null;
  const region = regionRaw
    ? (() => {
      const normalizedRaw = regionRaw.normalized && typeof regionRaw.normalized === "object"
        && !Array.isArray(regionRaw.normalized)
        ? regionRaw.normalized as Record<string, unknown>
        : null;
      const pixels = parseBounds(regionRaw.pixels);
      if (!normalizedRaw || !pixels) return undefined;
      const x = Number(normalizedRaw.x);
      const y = Number(normalizedRaw.y);
      const nWidth = Number(normalizedRaw.width);
      const nHeight = Number(normalizedRaw.height);
      if (![x, y, nWidth, nHeight].every(Number.isFinite)) return undefined;
      return {
        normalized: { x, y, width: nWidth, height: nHeight },
        pixels,
      };
    })()
    : undefined;
  const element = parseElementSummary(c.element);
  const intersecting = Array.isArray(c.intersecting)
    ? c.intersecting.map(parseElementSummary).filter((el): el is BrowserContextElementSummary => el !== undefined)
    : undefined;
  const screenshot = parseArtifactRef(c.screenshot);
  const crop = parseArtifactRef(c.crop);
  return {
    id: c.id,
    type,
    browserSessionId: c.browserSessionId,
    projectId: c.projectId,
    ...(typeof c.sessionId === "string" && c.sessionId ? { sessionId: c.sessionId } : {}),
    frameRevision,
    url: c.url,
    title: c.title,
    viewport: { width, height },
    capturedAt: c.capturedAt,
    ...(typeof c.note === "string" ? { note: c.note } : {}),
    ...(typeof c.quote === "string" ? { quote: c.quote } : {}),
    ...(typeof c.textSummary === "string" ? { textSummary: c.textSummary } : {}),
    ...(typeof c.accessibilitySummary === "string" ? { accessibilitySummary: c.accessibilitySummary } : {}),
    ...(typeof c.contentHash === "string" ? { contentHash: c.contentHash } : {}),
    ...(region ? { region } : {}),
    ...(element ? { element } : {}),
    ...(intersecting && intersecting.length ? { intersecting } : {}),
    ...(screenshot ? { screenshot } : {}),
    ...(crop ? { crop } : {}),
  };
}

function hostPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------- dictation (WP15)

export interface DictationSessionDto {
  id: string;
  sessionId?: string;
  status: "starting" | "recording" | "finalizing" | "done" | "failed";
  format: { encoding: "pcm_s16le"; sampleRate: number; channels: number };
  acknowledgedSeq: number;
  transcript: string;
}

// ---------------------------------------------------------------- commands / settings / shortcuts (WP9/WP13)

export interface CommandDescriptor {
  id: string;
  label: string;
  group: string;
  keywords?: string[];
  defaultShortcut?: string[];
  when?: string;
  requiresCapabilities?: string[];
}

export interface SettingsSearchItem {
  id: string;
  pageId: string;
  label: string;
  description?: string;
  keywords?: string[];
  focusTarget: string;
}

export interface SettingsPageMeta {
  label: string;
  group: PackageSettingsGroup;
  icon?: string;
  settingsItems?: SettingsSearchItem[];
  /** Links the settings page to its package enablement state. */
  packageId?: string;
}

export interface ShortcutBinding {
  commandId: string;
  sequence: string[];
  when?: string;
}

// ---------------------------------------------------------------- workspace search (WP13)

/** One row of `/api/search/workspaces`: a project or session matched on
 *  metadata only (never transcript bodies). */
export interface WorkspaceSearchItem {
  kind: "project" | "session";
  id: string;
  projectId?: string;
  title: string;
  /** Project: path. Session: "project · branch · status" fragments. */
  subtitle?: string;
  keywords?: string[];
  status?: string;
  updatedAt: number;
  archived?: boolean;
}

export interface FileSearchItem {
  path: string;
  kind: "file" | "dir";
  score: number;
  matches?: Array<[number, number]>;
}

// ---------------------------------------------------------------- notifications (WP15)

export type NotificationKind = "completed" | "failed" | "question" | "permission" | "subagent";
export interface NotificationPrefs {
  enabled: boolean;
  sound: boolean;
  kinds: NotificationKind[];
  onlyWhenHidden: boolean;
  template: string;
  summarize: boolean;
}

/** One retained notification-centre row (NTF-01). Derived server state:
 *  never a `SessionEvent`, never model-visible, never in the session log.
 *  `id` is the REST/WS merge identity and mutation handle; `key` is the
 *  stable transition key shared with the push payload (non-unique: a later
 *  identical transition legitimately produces a new row). */
export type NotificationRecord = {
  id: string;
  key: string;
  kind: NotificationKind;
  sessionId: string;
  projectId: string;
  title: string;
  body: string;
  ts: number;
  read: boolean;
};

// Well-known capability keys
export const CAP = {
  sessions: cap<SessionService>("polyth.sessions"),
  sessionPersistence: cap<SessionPersistence>("polyth.sessionPersistence"),
  runtime: cap<AgentRuntime>("polyth.agentRuntime"),
  projects: cap<ProjectService>("polyth.projects"),
  taskTrackers: cap<TaskTrackerService>("polyth.taskTrackers"),
  ui: cap<UiContributionRegistry>("polyth.ui"),
} as const;

/** Capability ids exposed by the composed server to clients and agent
 * sessions. Keeping this normative list in contracts prevents the composition
 * root from accumulating feature-specific declarations. */
export const SERVER_CAPABILITY_IDS = [
  "polyth.sessions",
  "polyth.sessionPersistence",
  "polyth.projects",
  "polyth.agentRuntime",
  "polyth.goals",
  "polyth.files",
  "polyth.commands",
  "polyth.git",
  "polyth.worktrees",
  "polyth.terminal",
  "polyth.multirun",
  "polyth.workflow",
  "polyth.fusion",
  "polyth.walkthrough",
  "polyth.schedule",
  "polyth.tracks",
  "polyth.github",
  "polyth.taskTrackers",
  "polyth.control",
  "polyth.agentProfiles",
  "polyth.settings",
  "polyth.mcp",
  "polyth.plugins",
  "polyth.knowledge",
  "polyth.review",
  "polyth.usage",
  "polyth.browser",
  "polyth.voice",
  "polyth.assist",
  "polyth.homeAssistant",
  "polyth.secureSafe",
  "polyth.ssh",
  "polyth.tunnel",
] as const;

// ---------------------------------------------------------------- Polyth Link (remote access)

export const POLYTH_LINK_ALPN = "polyth-link/1";
export const POLYTH_LINK_TICKET_VERSION = 1 as const;
export const POLYTH_PAIRING_TTL_MS = 120_000;
export const POLYTH_LINK_WORDLIST_VERSION = "polyth-link-words-v1";

export const REMOTE_CAPABILITY = {
  coreProjectsRead: "core.projects.read",
  coreProjectsWrite: "core.projects.write",
  coreSessionsRead: "core.sessions.read",
  coreSessionsCreate: "core.sessions.create",
  coreSessionsMessage: "core.sessions.message",
  coreSessionsControl: "core.sessions.control",
  coreSessionsDelete: "core.sessions.delete",
  coreNotificationsRead: "core.notifications.read",
  coreRequestsRespond: "core.requests.respond",
  coreHealthRead: "core.health.read",
  filesRead: "files.read",
  filesWrite: "files.write",
  terminalOpen: "terminal.open",
  terminalInput: "terminal.input",
  terminalResize: "terminal.resize",
  gitRead: "git.read",
  gitWrite: "git.write",
  browserUse: "browser.use",
  dictationUse: "dictation.use",
  tunnelStatusRead: "tunnel.status.read",
  tunnelDevicesManage: "tunnel.devices.manage",
  tunnelPairingManage: "tunnel.pairing.manage",
  tunnelGrantsManage: "tunnel.grants.manage",
  authPasswordManage: "auth.password.manage",
  authSessionsManage: "auth.sessions.manage",
  packagesInstall: "packages.install",
  packagesEnable: "packages.enable",
  packagesDisable: "packages.disable",
  secureSafeSecretsRead: "secure-safe.secrets.read",
  secureSafeSecretsExport: "secure-safe.secrets.export",
  serverShutdown: "server.shutdown",
  serverIdentityRotate: "server.identity.rotate",
} as const;

export type RemoteCapability = (typeof REMOTE_CAPABILITY)[keyof typeof REMOTE_CAPABILITY];

export const REMOTE_CAPABILITY_VALUES: readonly RemoteCapability[] = Object.values(REMOTE_CAPABILITY);

export function isRemoteCapability(value: string): value is RemoteCapability {
  return (REMOTE_CAPABILITY_VALUES as readonly string[]).includes(value);
}

export function normalizeRemoteGrants(grants: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const capability of grants) {
    if (!isRemoteCapability(capability)) {
      throw Object.assign(new Error(`unknown remote capability: ${capability}`), { code: "invalid-input" });
    }
    unique.add(capability);
  }
  return [...unique].sort();
}

export type GrantProfileId = "observe" | "interact" | "developer" | "full-remote";

export const GRANT_PROFILE_PRESETS: Record<GrantProfileId, readonly string[]> = {
  observe: [
    REMOTE_CAPABILITY.coreProjectsRead,
    REMOTE_CAPABILITY.coreSessionsRead,
    REMOTE_CAPABILITY.coreNotificationsRead,
    REMOTE_CAPABILITY.coreHealthRead,
    REMOTE_CAPABILITY.tunnelStatusRead,
  ],
  interact: [
    REMOTE_CAPABILITY.coreProjectsRead,
    REMOTE_CAPABILITY.coreSessionsRead,
    REMOTE_CAPABILITY.coreNotificationsRead,
    REMOTE_CAPABILITY.coreHealthRead,
    REMOTE_CAPABILITY.tunnelStatusRead,
    REMOTE_CAPABILITY.coreSessionsCreate,
    REMOTE_CAPABILITY.coreSessionsMessage,
    REMOTE_CAPABILITY.coreSessionsControl,
    REMOTE_CAPABILITY.coreRequestsRespond,
  ],
  developer: [
    REMOTE_CAPABILITY.coreProjectsRead,
    REMOTE_CAPABILITY.coreSessionsRead,
    REMOTE_CAPABILITY.coreNotificationsRead,
    REMOTE_CAPABILITY.coreHealthRead,
    REMOTE_CAPABILITY.tunnelStatusRead,
    REMOTE_CAPABILITY.coreSessionsCreate,
    REMOTE_CAPABILITY.coreSessionsMessage,
    REMOTE_CAPABILITY.coreSessionsControl,
    REMOTE_CAPABILITY.coreRequestsRespond,
    REMOTE_CAPABILITY.filesRead,
    REMOTE_CAPABILITY.filesWrite,
    REMOTE_CAPABILITY.terminalOpen,
    REMOTE_CAPABILITY.terminalInput,
    REMOTE_CAPABILITY.terminalResize,
    REMOTE_CAPABILITY.gitRead,
    REMOTE_CAPABILITY.gitWrite,
    REMOTE_CAPABILITY.browserUse,
  ],
  "full-remote": [
    REMOTE_CAPABILITY.coreProjectsRead,
    REMOTE_CAPABILITY.coreProjectsWrite,
    REMOTE_CAPABILITY.coreSessionsRead,
    REMOTE_CAPABILITY.coreSessionsCreate,
    REMOTE_CAPABILITY.coreSessionsMessage,
    REMOTE_CAPABILITY.coreSessionsControl,
    REMOTE_CAPABILITY.coreSessionsDelete,
    REMOTE_CAPABILITY.coreNotificationsRead,
    REMOTE_CAPABILITY.coreRequestsRespond,
    REMOTE_CAPABILITY.coreHealthRead,
    REMOTE_CAPABILITY.filesRead,
    REMOTE_CAPABILITY.filesWrite,
    REMOTE_CAPABILITY.terminalOpen,
    REMOTE_CAPABILITY.terminalInput,
    REMOTE_CAPABILITY.terminalResize,
    REMOTE_CAPABILITY.gitRead,
    REMOTE_CAPABILITY.gitWrite,
    REMOTE_CAPABILITY.browserUse,
    REMOTE_CAPABILITY.tunnelStatusRead,
  ],
};

/** Privileges that never ride along with Full remote control. */
export const PRIVILEGED_REMOTE_CAPABILITIES: readonly string[] = [
  REMOTE_CAPABILITY.tunnelPairingManage,
  REMOTE_CAPABILITY.tunnelDevicesManage,
  REMOTE_CAPABILITY.tunnelGrantsManage,
  REMOTE_CAPABILITY.authPasswordManage,
  REMOTE_CAPABILITY.authSessionsManage,
  REMOTE_CAPABILITY.packagesInstall,
  REMOTE_CAPABILITY.packagesEnable,
  REMOTE_CAPABILITY.packagesDisable,
  REMOTE_CAPABILITY.secureSafeSecretsRead,
  REMOTE_CAPABILITY.secureSafeSecretsExport,
  REMOTE_CAPABILITY.serverShutdown,
  REMOTE_CAPABILITY.serverIdentityRotate,
];

export function normalizeDeviceGrants(grants: readonly string[]): string[] {
  const normalized = normalizeRemoteGrants(grants);
  for (const capability of normalized) {
    if ((PRIVILEGED_REMOTE_CAPABILITIES as readonly string[]).includes(capability)) {
      throw Object.assign(new Error(`privileged capability cannot be granted: ${capability}`), { code: "invalid-input" });
    }
  }
  return normalized;
}

/** Local web UI principals keep existing unrestricted WS/HTTP behavior. */
export function isLocalUiPrincipal(principal: AuthPrincipal): boolean {
  return principal.kind === "local-user" || principal.kind === "ui-session";
}

/** Capability check for paired devices. Local UI principals are unrestricted. */
export function principalAllowsRemoteCapability(principal: AuthPrincipal, capability: string): boolean {
  if (isLocalUiPrincipal(principal)) return true;
  if (principal.kind === "paired-device") return principal.grants.includes(capability);
  return false;
}

export type PolythLinkTransport = "direct" | "relay";
export type PolythLinkPathPolicy = "direct-preferred" | "relay-only" | "air-gapped";

export interface PolythLinkCandidate {
  kind: "iroh";
  endpointId: string;
  relayUrls: string[];
  directAddresses?: string[];
  priority: number;
  policy: "direct-preferred" | "relay-only";
}

export interface PolythPairingTicketV1 {
  version: 1;
  kind: "polyth-link-pair";
  pairingId: string;
  inviteSecret: string;
  host: { endpointId: string; label?: string };
  issuedAt: string;
  expiresAt: string;
  protocol: { alpn: typeof POLYTH_LINK_ALPN; minVersion: 1; maxVersion: 1 };
  candidates: PolythLinkCandidate[];
}

export type PairingHostState =
  | "created"
  | "claimed"
  | "proof-verified"
  | "waiting-device-confirmation"
  | "waiting-host-confirmation"
  | "committing"
  | "committed"
  | "expired"
  | "cancelled"
  | "rejected"
  | "failed";

export interface PairingDevicePreview {
  label: string;
  platform?: string;
  model?: string;
  appVersion?: string;
  endpointFingerprint: string;
}

export interface PairingOfferDto {
  pairing: {
    id: string;
    expiresAt: string;
    safetyPhrase: string[] | null;
    state: PairingHostState;
  };
  ticket: string;
  qrPayload: string;
}

export interface PairingStateDto {
  id: string;
  state: PairingHostState;
  expiresAt: string;
  device?: PairingDevicePreview;
  safetyPhrase: string[] | null;
  requestedGrants: string[];
  deviceConfirmed: boolean;
  hostConfirmed: boolean;
  transport?: PolythLinkTransport;
}

export interface TunnelDeviceDto {
  id: string;
  label: string;
  platform?: string;
  model?: string;
  appVersion?: string;
  endpointFingerprint: string;
  createdAt: number;
  updatedAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
  grantRevision: number;
  grants: string[];
  lastTransport?: PolythLinkTransport;
  online: boolean;
  activeConnectionCount: number;
}

export interface TunnelStatusDto {
  enabled: boolean;
  available: boolean;
  pairingAvailable: boolean;
  hostBinaryFound: boolean;
  hostProcessReady: boolean;
  endpointBound: boolean;
  ingressReady: boolean;
  activePolicy: PolythLinkPathPolicy | null;
  mode: PolythLinkPathPolicy;
  hostFingerprint: string | null;
  fingerprint: string | null;
  relayConfigured: boolean;
  identityAvailable: boolean;
  identityError?: string;
  lastErrorCode?: string;
  unsupportedPlatform?: boolean;
  activeConnections: number;
  activeDevices: number;
  directConnections: number;
  relayConnections: number;
}

export interface TunnelDiagnosticsDto {
  appVersion: string;
  irohVersion: string;
  hostFingerprint: string | null;
  relayUrls: string[];
  path?: PolythLinkTransport;
  rttMs?: number;
  recentErrors: string[];
  grantRevision?: number;
  packageStatus: string;
}

export interface PackageEvent {
  packageId: string;
  type: string;
  revision: number;
  data: JsonObject;
}

export type PolythLinkErrorCode =
  | "pairing-invalid"
  | "pairing-expired"
  | "pairing-claimed"
  | "pairing-cancelled"
  | "pairing-rejected"
  | "pairing-confirmation-required"
  | "pairing-storage-failed"
  | "host-identity-mismatch"
  | "host-identity-corrupt"
  | "host-identity-rotated"
  | "device-unknown"
  | "device-revoked"
  | "device-grant-denied"
  | "device-grant-stale"
  | "relay-unreachable"
  | "direct-unreachable"
  | "transport-unavailable"
  | "transport-outcome-unknown"
  | "transport-protocol-error"
  | "transport-version-unsupported"
  | "proxy-bootstrap-invalid"
  | "proxy-session-invalid"
  | "proxy-origin-denied"
  | "request-path-denied"
  | "request-header-invalid"
  | "request-too-large"
  | "request-rate-limited"
  | "stream-limit-exceeded"
  | "forbidden"
  | "unauthorized";

export interface PolythLinkErrorDto {
  error: PolythLinkErrorCode;
  message: string;
  retryable: boolean;
  detail?: string;
}

// ---------------------------------------------------------------- handoff bridge

export interface ContextSourceDescriptorDto {
  id: string;
  label: string;
  description: string;
  defaultOn?: boolean;
}

export interface ContextBundleSourceDto {
  id: string;
  params?: JsonObject;
  tokens: number;
  fingerprint: string;
  status: "ok" | "missing" | "error";
  error?: string;
}

export interface ContextBundleWarningDto {
  tokens: number;
  largestSources: Array<{ id: string; label: string; tokens: number }>;
}

export interface ContextBundleSectionDto {
  id: string;
  sourceId: string;
  title: string;
  body: string;
  tokens: number;
  fingerprint: string;
}

export interface ContextBundleOmissionDto {
  sourceId: string;
  label: string;
  total: number;
  included: number;
  omitted: number;
  reason: string;
}

export interface ContextBundleDto {
  id: string;
  projectId: string;
  sessionId: string;
  presetId: string;
  label: string;
  instruction: string;
  sections: ContextBundleSectionDto[];
  sources: ContextBundleSourceDto[];
  markdown: string;
  tokens: number;
  createdAt: number;
  fingerprints: Record<string, string>;
  omissions?: ContextBundleOmissionDto[];
  warning?: ContextBundleWarningDto;
}

export interface HandoffPresetDto {
  id: string;
  label: string;
  instruction: string;
  sources: Array<{ id: string; params?: JsonObject }>;
}

export interface HandoffResultImportedData {
  provenance: {
    sourceKind: "chat-workspace";
    provider: string;
    profileName: string;
    tabTitle?: string;
    bundleId?: string;
    bundleLabel?: string;
  };
  textHash: string;
}

export interface HandoffBundleStaleDto {
  stale: boolean;
  staleSources: Array<{ id: string; reason: string }>;
}

// ---------------------------------------------------------------- chat workspace

export interface ChatProviderDto {
  id: string;
  name: string;
  homeUrl: string;
  allowedOrigins: string[];
}

export interface ChatProfileDto {
  id: string;
  providerId: string;
  name: string;
  customUrl?: string;
  createdAt: number;
  lastUsedAt: number;
  approvedOrigins: string[];
}

export interface ChatTabDto {
  id: string;
  profileId: string;
  url: string;
  title: string;
  pinned: boolean;
  lastActiveAt: number;
  hibernated: boolean;
  contentAccess: ContentAccessPolicy;
}

export interface ChatTabStateDto {
  tab: ChatTabDto;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  pendingApproval?: { origin: string; reason: string; url?: string } | null;
  pendingPopups?: Array<{ popupId: string; url?: string }>;
  pendingFileChooser?: boolean;
  hibernated?: boolean;
  crashed?: boolean;
  unreachable?: boolean;
  profileRestarted?: boolean;
  downloadBlocked?: boolean;
  liveTabCount?: number;
}

export interface ChatTabEventDto {
  tabId: string;
  kind: string;
  origin?: string;
  reason?: string;
  message?: string;
  url?: string;
  popupId?: string;
  text?: string;
}

export interface ChatWorkspaceDto {
  tabs: ChatTabDto[];
  activeTabId: string | null;
  order: string[];
}

export interface ChatWorkspaceSettingsDto {
  liveTabLimit: number;
  hibernateDelayMs: number;
  streamQuality: number;
  warnTokenThreshold: number;
  defaultProviderId: string;
  defaultTarget: "current-session" | "queue" | "new-session" | "draft";
  externalLinkBehavior: "prompt" | "allow" | "system";
  restoreLastTabs: boolean;
}

export interface ChatWorkspaceFrame {
  tabId: string;
  spaceId: string;
  revision: number;
  mime: string;
  data: Uint8Array;
  width: number;
  height: number;
  popupId?: string;
}

export interface ChatWorkspaceTabEvent extends ChatTabEventDto {
  spaceId: string;
}

export interface ChatWorkspaceFrameBus {
  latestFrame(spaceId: string, tabId: string, afterRevision?: number, popupId?: string): ChatWorkspaceFrame | null;
  onFrame(cb: (frame: ChatWorkspaceFrame) => void): Disposable;
  onEvent(cb: (event: ChatWorkspaceTabEvent) => void): Disposable;
  setTabStream(spaceId: string | null, tabId: string, visible: boolean, quality?: number): void;
}

// ---------------------------------------------------------------------------
// Canonical model + attachment control rules.
//
// These are pure decisions every layer has to agree on: which delivery
// modality an attachment ref is, what the harness ∩ model ∩ remote-policy
// intersection actually supports, and whether a (model, variant) pair is
// sendable. They live on the contract surface because the browser, the
// admission path and every adapter must apply the SAME rule — a composer that
// offers what the send refuses, or a variant honoured on one path and dropped
// on another, is the bug this prevents. `@polyth/harness-runtime` re-exports
// them so adapters keep one import site.
// ---------------------------------------------------------------------------

const MODEL_INPUT_MODALITIES = new Set<AttachmentModality>(["image", "pdf", "audio"]);

/** Classify one attachment ref into a delivery modality. */
export const attachmentModality = (ref: AttachmentRef): AttachmentModality | undefined => {
  if (ref.kind === "browser-context") {
    const shot = ref.browserContext?.crop ?? ref.browserContext?.screenshot;
    if (shot?.mime?.startsWith("image/")) return "image";
    return undefined;
  }
  // Presentational `/api/files/raw` URLs on path attachments must not win over
  // mime/kind. True link attachments use kind: "url".
  if (ref.kind === "url") return "url";
  if (ref.mime?.startsWith("image/") || ref.kind === "image") return "image";
  if (ref.mime === "application/pdf") return "pdf";
  if (ref.mime?.startsWith("audio/")) return "audio";
  if (ref.path || ref.kind === "file" || ref.kind === "range") return "file";
  if (ref.url) return "url";
  return undefined;
};

const modalityFromCapability = (cap: string): AttachmentModality | undefined => {
  if (cap === "input:image") return "image";
  if (cap === "attachment" || cap === "input:file") return "file";
  if (cap === "input:pdf") return "pdf";
  if (cap === "input:audio") return "audio";
  if (cap === "input:url") return "url";
  return undefined;
};

const intersectSupport = (
  a: FeatureSupport | undefined,
  b: FeatureSupport | undefined,
): FeatureSupport | undefined => {
  if (a === "unsupported" || b === "unsupported") return "unsupported";
  if (a === "emulated" || b === "emulated") return "emulated";
  if (a === "native" && b === "native") return "native";
  return undefined;
};

/** Intersection of harness capabilities, model capabilities, and remote policy. */
export const effectiveAttachmentSupport = (
  harness: RuntimeCapabilities,
  modelCapabilities: readonly string[] | undefined,
  remote: boolean,
  materializeAvailable = false,
): Partial<Record<AttachmentModality, FeatureSupport>> => {
  const harnessModalities = harness.attachments?.modalities ?? {};
  const modelModalities = new Map<AttachmentModality, FeatureSupport>();
  for (const cap of modelCapabilities ?? []) {
    const modality = modalityFromCapability(cap);
    if (modality) modelModalities.set(modality, "native");
  }
  const result: Partial<Record<AttachmentModality, FeatureSupport>> = {};
  const keys = new Set<AttachmentModality>([
    ...Object.keys(harnessModalities) as AttachmentModality[],
    ...modelModalities.keys(),
  ]);
  for (const modality of keys) {
    const harnessSupport = harnessModalities[modality];
    const modelSupport = modelModalities.get(modality);
    if (!harnessSupport || harnessSupport === "unsupported") continue;
    if (MODEL_INPUT_MODALITIES.has(modality)
      && modelCapabilities !== undefined
      && modelSupport === undefined) continue;
    if (modelSupport === "unsupported") continue;
    if (remote && (modality === "file" || modality === "pdf" || modality === "audio")) {
      if (!materializeAvailable) continue;
      const intersected = intersectSupport(harnessSupport, modelSupport ?? "native");
      if (intersected) result[modality] = intersected === "native" ? "emulated" : intersected;
      continue;
    }
    const intersected = intersectSupport(harnessSupport, modelSupport ?? "native");
    if (intersected) result[modality] = intersected;
  }
  return result;
};

export type ModelSelection =
  | {
    ok: true;
    /** Absent when the catalog could not answer for this harness. */
    descriptor?: ModelDescriptor;
    /** Absent means "use the backend's own default reasoning mode". */
    variant?: string;
  }
  | { ok: false; code: Extract<TurnRejectionCode, "invalid-model" | "invalid-variant">; message: string };

const belongsToHarness = (descriptor: ModelDescriptor, harnessId?: string): boolean =>
  harnessId === undefined || descriptor.harnessId === undefined || descriptor.harnessId === harnessId;

/** The models a harness can actually route to, in catalog order. */
export const harnessModels = (
  catalog: readonly ModelDescriptor[],
  harnessId?: string,
): ModelDescriptor[] => catalog.filter((descriptor) => belongsToHarness(descriptor, harnessId));

/**
 * Find the descriptor a ref names. Provider + model are both identity fields;
 * adapters whose native protocol omits a provider must normalize one before
 * publishing their canonical catalog.
 */
export const findModelDescriptor = (
  catalog: readonly ModelDescriptor[],
  ref: Pick<ModelRef, "providerID" | "modelID">,
  harnessId?: string,
): ModelDescriptor | undefined => {
  return harnessModels(catalog, harnessId).find((descriptor) =>
    descriptor.providerID === ref.providerID && descriptor.modelID === ref.modelID);
};

/**
 * Validate a model + variant selection against a harness catalog.
 *
 * An empty catalog for the harness means "not discoverable right now", not
 * "no such model": validation defers to the adapter rather than inventing a
 * rejection the user cannot act on.
 */
export function resolveModelSelection(
  catalog: readonly ModelDescriptor[],
  ref: ModelRef | undefined,
  harnessId?: string,
): ModelSelection {
  if (!ref) return { ok: true };
  const known = harnessModels(catalog, harnessId);
  const descriptor = findModelDescriptor(catalog, ref, harnessId);
  const variant = ref.variant?.trim() ? ref.variant : undefined;
  if (!descriptor) {
    if (known.length === 0) return { ok: true, ...(variant ? { variant } : {}) };
    return {
      ok: false,
      code: "invalid-model",
      message: `${ref.modelID} is not available on this engine. Pick a model from the list.`,
    };
  }
  if (!variant) return { ok: true, descriptor };
  const variants = descriptor.variants ?? [];
  if (!variants.includes(variant)) {
    return {
      ok: false,
      code: "invalid-variant",
      message: variants.length
        ? `${descriptor.name} does not offer the "${variant}" thinking level. Choose one of: ${variants.join(", ")}.`
        : `${descriptor.name} does not offer a thinking level.`,
    };
  }
  return { ok: true, descriptor, variant };
}

/**
 * Reconcile a remembered variant against the model that is actually selected.
 * `reconciled` is true when the request could not be honoured, so the caller
 * can show the effective value instead of keeping a stale one.
 */
export function resolveVariantPreference(
  descriptor: Pick<ModelDescriptor, "variants" | "defaultVariant"> | undefined,
  requested: string | undefined,
): { variant?: string; reconciled: boolean } {
  const variants = descriptor?.variants ?? [];
  const wanted = requested?.trim() ? requested : undefined;
  if (variants.length === 0) return { reconciled: wanted !== undefined };
  if (wanted && variants.includes(wanted)) return { variant: wanted, reconciled: false };
  const fallback = descriptor?.defaultVariant && variants.includes(descriptor.defaultVariant)
    ? descriptor.defaultVariant
    : undefined;
  return { ...(fallback ? { variant: fallback } : {}), reconciled: wanted !== undefined };
}
