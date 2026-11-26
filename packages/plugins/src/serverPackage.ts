// Autonomous server-package discovery. Workspace feature packages opt in with
// a `"polyth": { "serverEntry": "./src/serverEntry.ts", "descriptor": ... }`
// marker in package.json; the entry default-exports a `registerPackage(host)`
// factory returning a `ServerPackage` (routes + enable/disable hooks). The
// server scans packages/*, loads every marked entry, and wires it into the
// package lifecycle — no static imports, descriptors, or manual registration
// in the composition root.
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { cap } from "@polyth/contracts";
import { OPTIONAL_EDITIONS } from "@polyth/contracts/edition";
import type {
  AgentCapabilityContributionRegistry,
  AgentRuntime,
  AuthPrincipal,
  AuthResolution,
  CapabilityKey,
  CreateIsolatedSessionInput,
  DelegatedIsolationDto,
  Disposable,
  HarnessSelection,
  IsolationMergeResultDto,
  IsolationStatusDto,
  IsolateSessionResultDto,
  JsonObject,
  ModelDescriptor,
  ModelRef,
  NotificationRecord,
  OpenCodeRuntimePolicyDto,
  PackageDescriptorDto,
  Plugin,
  ProjectService,
  RemoteAccessPolicy,
  RequestIngress,
  RewindFileKept,
  RewindFilesOutcome,
  RewindFilesPreview,
  RewindRestorePreview,
  RouteHandler,
  SessionEvent,
  WorkspaceCheckpointUnavailable,
  SessionIsolation,
  SessionPersistence,
  SessionPerson,
  SessionProjection,
  SessionRef,
  SessionStartRequest,
  StartSessionResult,
  SecureSafeService,
  SessionService,
  SessionPrivacy,
  SpaceContext,
  SpaceStorage,
  DeploymentProfile
} from "@polyth/contracts";
import type { RuntimeMutationStore } from "@polyth/session";
import type { TrustedServerPluginHost } from "./trustedServerEntry.ts";
import type { PairedSocketRegistry } from "./pairedSockets.ts";
import type { PeopleHost } from "./personConnections.ts";
import { packageScopedSecureSafe } from "./opaqueNamespace.ts";

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

// ---- server package contract ------------------------------------------------------

/** What a feature package's serverEntry returns; mirrors the server's
 *  packageLifecycle contract. `routes` is added to the route registry while the
 *  package is enabled and removed when it is disabled. */
export function localOnlyRemoteAccess(routeScopes: readonly string[]): RemoteAccessPolicy {
  return { routeScopes, http: [] };
}

/** What a feature package's serverEntry returns. Remote access is default-deny:
 *  omit `remoteAccess` and paired devices cannot reach the package. */
export interface ServerPackage {
  routes?: RouteHandler;
  remoteAccess?: RemoteAccessPolicy;
  onEnable?: () => void | Promise<void>;
  onDisable?: () => void | Promise<void>;
  /** Detach HTTP/WS ingress before the HTTP server drain. Packages that own
   *  upgraded sockets must implement this so `server.close()` is not pinned. */
  stopIngress?: () => void | Promise<void>;
}

export type ServerPackageFactory = (
  host: ServerPackageHost,
) => ServerPackage | Promise<ServerPackage>;

// ---- shared core services on the host --------------------------------------------

/** Session fan-out to connected clients (structural mirror of the server's
 *  Broadcaster; events must already be persisted before they are broadcast). */
export interface ServerBroadcast {
  event(ev: SessionEvent): void;
  projection(p: SessionProjection): void;
  notification?(record: NotificationRecord): void;
  pluginChanged?(packageId: string): void;
  packageChanged?(pkg: PackageDescriptorDto): void;
  /** One repository's worktree topology changed. Scoped to the affected
   *  project so clients refetch that topology and nothing else. */
  worktreesChanged?(projectId: string): void;
}

/** Per-project agent-runtime pool (structural mirror of the server's pool). */
export interface ServerRuntimePool {
  /** `cwd` overrides the project root — that is how worktree sessions are isolated. */
  forProject(projectId: string, cwd?: string, targetHarnessId?: string): Promise<AgentRuntime>;
  forSession?(projection: SessionProjection, cwd: string, targetHarnessId?: string): Promise<AgentRuntime>;
  restartAll?(): Promise<number>;
  /** Release project-scoped utility runtimes acquired in `cwd` before that
   *  directory is deleted. Canonical session leases are not affected. */
  retireWorkspace?(cwd: string): Promise<void>;
}

/** A session's runtime plus the context needed to run one-shot completions on it. */
export interface SessionRuntimeBinding {
  rt: AgentRuntime;
  cwd: string;
  model?: ModelRef;
  agent?: string;
}

export interface ServerOneShotOptions {
  cwd: string;
  prompt: string;
  model?: ModelRef;
  agent?: string;
  timeoutMs?: number;
  /** Stable logical task identity for response-loss deduplication. */
  taskId?: string;
  /** Utility purpose forwarded on the turn so the adapter can recognise it
   *  (for example a native agent choice or a measured probe). */
  purpose?: string;
}

export interface ServerSmallModelOptions {
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  model?: ModelRef;
  maxOutputTokens: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  responseSchema?: JsonObject;
  purpose?: string;
  /** Only the runtime's tool-less direct completion may answer. Without one the
   *  call fails `unsupported` instead of running the prompt as an agent turn —
   *  required whenever the prompt carries untrusted evidence. */
  requireDirect?: boolean;
}

export interface ServerSmallModelResult {
  text: string;
  providerID: string;
  modelID: string;
  inputTruncated: boolean;
  transport: "direct" | "compatibility";
  latencyMs: number;
  firstTokenMs?: number;
}

export type AppendEventOptions = Partial<
  Pick<SessionEvent, "ignorable" | "surfaceOp" | "sourceEventSeqs" | "producerPlugin">
>;

/** Handed to `onHttpServer` callbacks once the gateway's HTTP server exists. */
export interface HttpServerContext {
  server: import("node:http").Server;
  /** Public listener id, or `polyth-link` for the internal tunnel ingress. */
  listenerId: string;
  /** Canonical HTTP handler shared by the public listener and tunnel ingress. */
  dispatch(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
    ingress: RequestIngress,
  ): Promise<void>;
  resolve(
    request: import("node:http").IncomingMessage,
    ingress: RequestIngress,
  ): AuthResolution;
  /** True when the upgrade may proceed. Uses the listener's trusted ingress. */
  authorize(request: import("node:http").IncomingMessage): boolean;
  /** Immutable identity accepted for this upgrade. */
  identity(request: import("node:http").IncomingMessage): AuthResolution;
  /** Re-read live paired-device grants. Null means the principal is gone/revoked. */
  refreshPrincipal(principal: AuthPrincipal): AuthPrincipal | null;
  /** Close matching paired-device sockets on revoke/disconnect. */
  pairedSockets: PairedSocketRegistry;
}

/** Cross-package service seam. Each discovered package constructs its own
 *  services during `registerPackage` and provides them under well-known keys
 *  (`serverServiceKey(name)`); the composition root only provides the few
 *  infrastructure seams packages cannot build themselves (voice settings,
 *  secure-safe, config applier, remote probe). Resolve dependencies lazily
 *  (inside `onEnable` or route handlers), never at `registerPackage` time —
 *  load order between packages is alphabetical, not dependency-sorted. */
export interface ServerServiceRegistry {
  /** Register a service instance. Throws on a duplicate id. */
  provide<T>(key: CapabilityKey<T>, service: T): void;
  get<T>(key: CapabilityKey<T>): T | undefined;
  /** Like `get`, but throws `not-found` when the service is missing. */
  require<T>(key: CapabilityKey<T>): T;
  ids(): string[];
}

/** Well-known id convention for shared server services: `polyth.service.<name>`. */
export const serverServiceKey = <T>(name: string): CapabilityKey<T> =>
  cap<T>(`polyth.service.${name}`);

/** Package-owned policy, consumed lazily by the managed physical runtime owner. */
export interface ServerOpenCodeRuntimePolicy {
  read(space: SpaceContext): OpenCodeRuntimePolicyDto;
  /** An absent Space id refreshes all currently materialized Spaces. */
  onChange(listener: (spaceId?: string) => void): Disposable;
}

export const SERVER_OPENCODE_RUNTIME_POLICY =
  serverServiceKey<ServerOpenCodeRuntimePolicy>("opencode.runtime-policy");

export interface ServerTurnCompletedEvent {
  sessionId: string;
  assistantText: string;
  userId?: string;
}

export interface ServerTurnCompletionBus {
  subscribe(
    listener: (event: ServerTurnCompletedEvent) => void | Promise<void>,
  ): Disposable;
}

export const SERVER_TURN_COMPLETION_BUS =
  serverServiceKey<ServerTurnCompletionBus>("session.turn-completed");

/** Every terminal turn stop, whatever its reason. Published after the stop
 *  is durable; a stop with a pending provider-limit resume is still
 *  published (listeners check `projection.resume`). Observation only. */
export interface ServerTurnStoppedEvent {
  sessionId: string;
  reason: "completed" | "aborted" | "error";
}

export interface ServerTurnStoppedBus {
  subscribe(listener: (event: ServerTurnStoppedEvent) => void | Promise<void>): Disposable;
}

export const SERVER_TURN_STOPPED_BUS =
  serverServiceKey<ServerTurnStoppedBus>("session.turn-stopped");

/** A live permission request that waits for a person's decision: no rule or
 *  automatic approval decided it (a decided answer that failed to deliver is
 *  never published), its card is published and the session waits. Published
 *  after the request is durable; requests re-published after a reconnect are
 *  not repeated. Observation only; an answer goes
 *  through the ordinary `replyPermission` of an authorized session facade. */
export interface ServerPermissionWaitingEvent {
  sessionId: string;
  requestId: string;
  /** False when the Space never answers automatically (it has a guarded
   *  member): nothing may approve this request for a person. */
  automaticAllowed: boolean;
}

export interface ServerPermissionWaitingBus {
  subscribe(listener: (event: ServerPermissionWaitingEvent) => void | Promise<void>): Disposable;
}

export const SERVER_PERMISSION_WAITING_BUS =
  serverServiceKey<ServerPermissionWaitingBus>("session.permission-waiting");

/** An open tool call has been quiet for a while (one minute before Polyth's
 *  silence stop by default) and nobody kept it running. Published once per
 *  quiet stretch, never for a kept call. Observation only: keeping it goes
 *  through an authorized facade's `keepToolRunning` (a judge passes
 *  `via: "judge"`); doing nothing lets the silence stop run at `stopsAt`.
 *  Read the call itself through that facade; this event names it only. */
export interface ServerToolQuietEvent {
  sessionId: string;
  callId: string;
  /** The call's tool name as the harness reported it. */
  tool: string;
  startedAt: number;
  /** When the call last showed activity (its start without progress frames). */
  quietSince: number;
  /** When the silence stop runs if nothing changes. */
  stopsAt: number;
  /** The session's Space (from its projection) when known. */
  spaceId?: string;
  projectId?: string;
}

export interface ServerToolQuietBus {
  subscribe(listener: (event: ServerToolQuietEvent) => void | Promise<void>): Disposable;
}

export const SERVER_TOOL_QUIET_BUS =
  serverServiceKey<ServerToolQuietBus>("session.tool-quiet");

/** A server account the owner is removing. Listeners run, and are awaited,
 *  before its credential goes, so access a package granted to the account
 *  (a paired phone, a token) ends with it. A failing listener is logged and
 *  does not keep the account. */
export interface ServerAccountRemovedEvent {
  userId: string;
}

export interface ServerAccountRemovalBus {
  subscribe(listener: (event: ServerAccountRemovedEvent) => void | Promise<void>): Disposable;
}

export const SERVER_ACCOUNT_REMOVAL_BUS =
  serverServiceKey<ServerAccountRemovalBus>("server.account-removed");

/** A package holding someone's private data says how much, so the instance
 *  owner can see its size when deciding about an account, and nothing else. */
export interface ServerPersonDataVolume {
  contribute(measure: (userId: string) => number | Promise<number>): Disposable;
}

export const SERVER_PERSON_DATA_VOLUME =
  serverServiceKey<ServerPersonDataVolume>("server.person-data-volume");

/** A Space of another Polyth server that one person on this server joined
 *  through Polyth Link (docs/architecture/polyth-link.md "Joined Spaces").
 *  It belongs to that person alone: no one else on this server sees it. */
export type JoinedSpace = import("@polyth/contracts").JoinedSpaceDto;

/** Where a request goes while a joined Space is active. The host decides
 *  which paths follow the Space (forwarded) and which stay on this server;
 *  the service only carries a request it is handed, as the person's paired
 *  device on the other server, and never forwards this server's cookies,
 *  authorization or CSRF headers. */
export interface JoinedSpacesService {
  /** The joined Spaces of one person (cached lists; never another person's). */
  list(userId: string): JoinedSpace[];
  /** The joined Space with this id, only when it is this person's. */
  get(userId: string, joinedSpaceId: string): JoinedSpace | undefined;
  /** Sends one HTTP request to the other server in that Space and streams
   *  the answer back. `path` is the canonical path with its query. */
  forwardHttp(userId: string, joinedSpaceId: string, input: {
    method: string;
    path: string;
    req: import("node:http").IncomingMessage;
    res: import("node:http").ServerResponse;
  }): Promise<void>;
  /** Hands a WebSocket upgrade (`/ws`) to the other server in that Space. */
  forwardUpgrade(userId: string, joinedSpaceId: string, input: {
    path: string;
    req: import("node:http").IncomingMessage;
    socket: import("node:stream").Duplex;
    head: Buffer;
  }): Promise<void>;
}

export const SERVER_JOINED_SPACES =
  serverServiceKey<JoinedSpacesService>("server.joined-spaces");

/** Notices for one person that no session of this server owns: today, those
 *  a joined Space's own server raised for the person (a mention, a message,
 *  an approval or question, a finished turn). The host files them in the
 *  person's notification list and sends them to the person's devices like
 *  any other, by the person's notification settings, tagged with
 *  `record.joinedSpace`; they never enter a session's history. A later
 *  notice with the same `key` replaces the earlier one. */
export interface ServerPersonNotices {
  deliver(userId: string, record: import("@polyth/contracts").NotificationRecord & {
    joinedSpace: NonNullable<import("@polyth/contracts").NotificationRecord["joinedSpace"]>;
  }): void;
  /** The other server cleared it (read there, answered, withdrawn). */
  withdraw(userId: string, key: string): void;
}

export const SERVER_PERSON_NOTICES =
  serverServiceKey<ServerPersonNotices>("server.person-notices");

/** True for an id shaped like a joined Space's (not proof that it is one). */
export const isJoinedSpaceId = (value: string | null | undefined): value is string =>
  typeof value === "string" && /^rmt_[0-9a-f]{24}$/.test(value);

/** An event source a package offers agents (Monitoring, Git, Home Assistant…). */
export interface AgentEventSourceDescriptor {
  /** Lowercase id, e.g. `monitoring`. */
  id: string;
  label: string;
  types: Array<{ id: string; label: string }>;
  /** Event fields the source fills that a wake can filter on (besides
   *  `title` and `text`), e.g. `repo`. Optional for older sources. */
  fields?: Array<{ id: string; label: string }>;
}

export interface AgentEventPublication {
  source: string;
  type: string;
  /** Space the event belongs to; agents outside it never see it. */
  spaceId: string;
  /** Narrows the event to one project; absent = every project in the Space. */
  projectId?: string;
  /** Short human title. Event text is data for agents, never instructions. */
  title: string;
  /** Extra filterable facts; `text` is shown to the agent (bounded), and
   *  `url` is shown as its link. */
  fields?: Record<string, string>;
  /** The one agent wake this event is for (see {@link AgentEventSubscription}),
   *  e.g. because it was read with that agent owner's account. No other
   *  agent sees it, and only that owner sees it in previews. */
  target?: { agentId: string; triggerId: string };
}

/** One active agent wake on a source, with what it asked for. Lets a source
 *  watch exactly the things a wake names (a repository in a `repo` filter)
 *  and act as the agent's owner. */
export interface AgentEventSubscription {
  spaceId: string;
  projectId: string;
  agentId: string;
  triggerId: string;
  /** The person the agent acts for; absent for an agent nobody owns. */
  ownerUserId?: string;
  /** Event types the wake listens to. */
  types: string[];
  filters: Array<{ field: string; op: "equals" | "not-equals" | "contains" | "not-contains"; value: string }>;
}

/** Provided by the Agents package. Sources register once and publish events;
 *  `subscribed` lets a source skip work nobody listens to. */
export interface AgentEventSources {
  register(source: AgentEventSourceDescriptor): Disposable;
  publish(event: AgentEventPublication): void;
  /** Projects (per Space) with an active agent waking on `source`. */
  subscribed(source: string): Array<{ spaceId: string; projectId: string }>;
  /** Every active agent wake on `source`. Optional for older hosts. */
  subscriptions?(source: string): AgentEventSubscription[];
}

export const AGENT_EVENT_SOURCES =
  serverServiceKey<AgentEventSources>("agents.event-sources");

/** Lets a package say an idle session's last answer waits on its person
 *  (e.g. a Judgment assessment). The host re-sends that session's turn
 *  notification as a question with the same key, so the OS notification is
 *  replaced rather than duplicated. Delivery only: it changes no state. */
export interface ServerSessionAttention {
  waitingForPerson(sessionId: string): void;
  /** Take over the routine "finished"/"failed" turn notifications of the
   *  sessions `owns` accepts (for example an agent's own sessions, whose
   *  package decides which results deserve the person's attention). Requests
   *  for approvals and answers still notify as usual. Optional for older hosts. */
  claimTurnNotifications?(owns: (sessionId: string) => boolean): Disposable;
  /** One notification about a session the caller owns. A later call with the
   *  same `key` replaces it. Delivery only: it changes no session state.
   *  `recipient` names the person a session started by server work (an
   *  agent's run) acts for: it becomes the session's notification owner when
   *  none is recorded yet, only while that person is a member of the
   *  session's Space. A recorded owner is never replaced. */
  notify?(sessionId: string, input: {
    kind: "completed" | "failed";
    statusText: string;
    key: string;
    recipient?: { userId: string };
  }): void;
}
export const SESSION_ATTENTION_SERVICE =
  serverServiceKey<ServerSessionAttention>("session.attention");

/** "paused": a person paused the source mid-turn. Not final: the watch stays
 *  armed and reports again when the work ends. A watch for "aborted" hears it
 *  too. */
export type ServerSessionWatchReason = "completed" | "error" | "aborted" | "paused";
export type ServerSessionWatchDelivery = "observe" | "wake";

export interface ServerSessionWatchDto {
  id: string;
  sourceSessionId: string;
  targetSessionId: string;
  events: ServerSessionWatchReason[];
  delivery: ServerSessionWatchDelivery;
  once: boolean;
  createdAt: number;
}

export interface ServerSessionWatchCreateInput {
  sourceSessionId: string;
  targetSessionId: string;
  events?: ServerSessionWatchReason[];
  delivery?: ServerSessionWatchDelivery;
  /** One-shot is the safe default for agent orchestration. */
  once?: boolean;
}

export interface ServerSessionWatchService {
  create(space: SpaceContext, input: ServerSessionWatchCreateInput): Promise<ServerSessionWatchDto>;
  list(space: SpaceContext, input?: {
    sourceSessionId?: string;
    targetSessionId?: string;
  }): Promise<ServerSessionWatchDto[]>;
  /** targetSessionId scopes agent-owned deletion to its own receiving session. */
  remove(space: SpaceContext, id: string, targetSessionId?: string): Promise<boolean>;
}

export const SERVER_SESSION_WATCHES =
  serverServiceKey<ServerSessionWatchService>("session.watches");

export interface ServerDelegatedSessionInput {
  /** The delegating session; the child becomes its canonical subagent. */
  parentSessionId: string;
  title?: string;
  harness?: HarnessSelection;
  model?: ModelRef;
  agent?: string;
}

export interface ServerDelegatedSessionCreated {
  id: string;
  isolation: SessionIsolation;
  /** Uncommitted paths in the parent's checkout. The child starts from the
   *  parent's last commit and does not see them. */
  originUncommitted: number;
}

export interface ServerDelegatedMergeResult {
  /** False when the child held no changes and its checkout was only released. */
  merged: boolean;
  commit?: string;
  targetBranch: string;
  /** False when the merge published but returning or cleaning the child's
   *  checkout still needs recovery; merging again resumes it. */
  finalized: boolean;
  session: SessionProjection;
}

/** Git-owned isolated checkouts for Polyth delegation. A delegated child is
 *  branched from its parent's current checkout — nested when that checkout is
 *  itself a managed isolation — and merges back into it. Callers authorize the
 *  parent/child relationship and Space before calling. */
export interface ServerSessionIsolationService {
  /** A new chat in its own managed checkout, branched from the project's
   *  current checkout, exactly as the new-session dialog's isolated option
   *  starts one. Pass the requester's scoped `sessions` so the chat is created
   *  in their Space and owned by them; the project is checked there. Refuses a
   *  project that is not a local Git repository. */
  createIsolatedSession(
    input: CreateIsolatedSessionInput & { start?: SessionStartRequest; clientOperationId?: string },
    options?: { sessions?: Pick<SessionService, "create" | "start" | "snapshot"> },
  ): Promise<StartSessionResult>;
  createDelegatedSession(input: ServerDelegatedSessionInput): Promise<ServerDelegatedSessionCreated>;
  /** The parent's delegated isolated children that still hold an isolation record. */
  delegatedChildren(parentSessionId: string): Promise<DelegatedIsolationDto[]>;
  /** Merge a delegated child into its parent's checkout and release the child's
   *  checkout. Never starts an AI repair of the parent's uncommitted work: an
   *  overlap is refused so the parent can commit its own changes first. */
  mergeDelegated(sessionId: string): Promise<ServerDelegatedMergeResult>;
  discard(sessionId: string): Promise<SessionProjection>;
  resolveWithAgent(sessionId: string): Promise<{ sessionId: string }>;
  /** The isolation card's state: what Merge, Keep or Discard may do now.
   *  Read-only; derived from Git and the persisted record. */
  getStatus(sessionId: string): Promise<IsolationStatusDto>;
  /** Exactly what the card's Merge button runs: commit the isolated work into
   *  the branch it started from and release the checkout (including the AI
   *  repair of overlapping uncommitted target work the button offers).
   *  Callers authorize the session before calling. */
  mergeBack(sessionId: string): Promise<IsolationMergeResultDto>;
  /** Move an existing ordinary session into its own managed checkout,
   *  branched from the checkout it works in now, which is also where its
   *  merge-back returns. Pass the requester's scoped `sessions`: the session is
   *  read and rebound through it, so its Space and the right to manage the
   *  chat are checked there. Refuses a running, archived or isolated chat. */
  isolateSession(
    sessionId: string,
    options?: { sessions?: Pick<SessionService, "snapshot" | "rebindWorkspace"> },
  ): Promise<IsolateSessionResultDto>;
}

export const SERVER_SESSION_ISOLATION =
  serverServiceKey<ServerSessionIsolationService>("isolation");

/** One admitted turn of the session being rolled back, oldest first. */
export interface WorkspaceCheckpointTurn {
  /** Seq of the user/message that started the turn. */
  promptSeq: number;
  /** Snapshot commits taken before the prompt reached the runtime and after
   *  the turn stopped. */
  before: string;
  after: string;
  /** Paths this chat's edit tools reported during the turn, absolute or
   *  relative to `cwd`; the service normalises them and drops outsiders. */
  touched: string[];
  /** Repo-relative paths either snapshot left out (too large). */
  skipped?: string[];
}

export type WorkspaceCheckpointCaptureResult =
  | { commit: string; root: string; skipped: string[]; skippedMore?: number }
  | { unavailable: WorkspaceCheckpointUnavailable };

/** What a redo needs: the snapshots a rollback recorded and what it wrote. */
export interface WorkspaceRestoreInput {
  cwd: string;
  undo: string;
  rolled: string;
  /** Repo-relative paths the rollback restored. */
  paths: string[];
}

/** Git-owned per-turn checkpoints and the file-by-file rollback built on them.
 *  A file is only ever written when it still holds exactly the content the
 *  compare names (what the agent left, or what the rollback wrote): every
 *  other file stays as it is and is reported, never merged or overwritten.
 *  The user's index, HEAD and branches are never changed. Callers authorize
 *  the session and resolve its checkout before calling. */
export interface WorkspaceCheckpointService {
  /** Snapshot the checkout's working tree under the session's checkpoint
   *  refs. Gives up (`timeout`) rather than exceed `budgetMs`. */
  capture(input: {
    cwd: string;
    sessionId: string;
    promptSeq: number;
    phase: "before" | "after";
    budgetMs: number;
  }): Promise<WorkspaceCheckpointCaptureResult>;
  /** What a rollback of `turns` would put back now. Read-only. */
  previewRewind(input: { cwd: string; sessionId: string; turns: WorkspaceCheckpointTurn[] }): Promise<Omit<RewindFilesPreview, "turnRunning">>;
  /** Put back every file the preview would, re-checking each one right
   *  before writing it. `mode: "unavailable"` when nothing could be. */
  applyRewind(input: { cwd: string; sessionId: string; turns: WorkspaceCheckpointTurn[] }): Promise<RewindFilesOutcome>;
  previewRestore(input: WorkspaceRestoreInput): Promise<RewindRestorePreview>;
  /** Redo: write back the pre-rollback content of every restored file that
   *  still holds exactly what the rollback wrote. */
  applyRestore(input: WorkspaceRestoreInput): Promise<{ restored: number; kept: number; keptFiles: RewindFileKept[] }>;
  /** Drop a deleted session's checkpoint refs. */
  forget(sessionId: string, cwd?: string): Promise<void>;
}

export const SERVER_WORKSPACE_CHECKPOINTS =
  serverServiceKey<WorkspaceCheckpointService>("workspace.checkpoints");

/** The account's starred model-picker entries as harness-qualified
 *  `harness::provider/model` keys, in the user's saved order. Read-only and
 *  scoped to one account; the web client owns the preference itself. */
export interface ServerModelFavoritesService {
  favorites(userId: string): string[];
}

export const SERVER_MODEL_FAVORITES =
  serverServiceKey<ServerModelFavoritesService>("models.favorites");

/** The server's native model catalog across every enabled harness: the list
 *  the model picker and the send preflight validate against. */
export interface ServerRuntimeCatalogService {
  /** `maxAgeMs` bounds the age of the server's copy for a caller that must act
   *  on the current list; an older copy is re-read through the harness
   *  registry first. Omitted: the server-lifetime copy. */
  models(options?: { maxAgeMs?: number }): Promise<ModelDescriptor[]>;
  invalidateModels(): void;
}

export const SERVER_RUNTIME_CATALOG =
  serverServiceKey<ServerRuntimeCatalogService>("runtime.catalog");

/** One spawnable harness/model pair ranked for delegation. `providerID` and
 *  `modelID` name the row of the harness's live catalog, which can differ from
 *  what telemetry reported (`opus`, not the `claude-opus-5-5` it runs). */
export interface ServerModelRoutingCandidate {
  harnessId: string;
  providerID: string;
  modelID: string;
  /** What an alias row runs now, as a readable name (`Claude Opus 5.5` for
   *  `opus`); absent for a concrete id. */
  runs?: string;
  /** The live catalog lists this selection. False only when the harness's
   *  catalog could not be read; pairs it no longer lists are left out. */
  listed: boolean;
  favorite: boolean;
  /** Turns and sessions observed in the window, failed turns among them. */
  turns: number;
  sessions: number;
  failed: number;
  lastUsedAt?: number;
  /** False when the harness is not registered on this server right now. */
  available: boolean;
  /** Worst applicable quota window as a 0..1 fraction; absent when unknown. */
  quotaUsed?: number;
  /** The window `quotaUsed` was read from: its label, reset and pace. */
  quotaWindow?: { sourceId: string; label: string; resetsAt?: number; pace?: "under" | "on-track" | "over" };
  /** Earliest reset of an exhausted window when `blocked`. */
  blockedUntil?: number;
  blocked: boolean;
  /** The harness as its registry names it ("Claude Code · Work"); absent
   *  when it is not registered now. */
  harnessName?: string;
  /** Position among the person's favorites (0 = first); absent when not starred. */
  favoriteIndex?: number;
  /** Why the caller's `order` moved this row; absent when it kept its place. */
  placed?: ServerModelRoutingPlacement;
  /** Every live quota window that meters this model, not just the fullest. */
  quotaWindows?: Array<{ sourceId: string; windowId: string }>;
}

/** `pinned`/`demoted`: the row's own key; `preferred`/`avoided`: its harness. */
export type ServerModelRoutingPlacement = "pinned" | "preferred" | "avoided" | "demoted";

/** A person's own order on top of the automatic ranking. Usable rows still
 *  come before unusable ones; inside each group, pinned rows (in `pin` order)
 *  lead, then preferred harnesses, the rest, avoided harnesses and finally
 *  demoted rows (in `demote` order), each keeping the automatic order. */
export interface ServerModelRoutingOrder {
  /** `harness::provider/model` keys listed first. A pinned pair is listed
   *  even when unused in the window, like a favorite. */
  pin?: readonly string[];
  /** Keys listed last. */
  demote?: readonly string[];
  /** Harness-wide placement by harness id. */
  harnesses?: Readonly<Record<string, "prefer" | "avoid">>;
}

export interface ServerModelRoutingQuota {
  /** Quota source id, e.g. `claude`, `claude-work`, `github-copilot`. */
  sourceId: string;
  label?: string;
  /** Registry name of the one harness whose listed models this source
   *  meters; absent when it meters several or none is registered. */
  harnessName?: string;
  windows: Array<{ id: string; label: string; used: number; resetsAt?: number; pace?: "under" | "on-track" | "over" }>;
  stale: boolean;
  fetchedAt: number;
}

export interface ServerModelRoutingReport {
  windowDays: number;
  generatedAt: number;
  candidates: ServerModelRoutingCandidate[];
  quotas: ServerModelRoutingQuota[];
  /** Candidates dropped by the row limit. */
  omitted: number;
  /** Used or starred pairs left out because their harness's live catalog no
   *  longer offers them. */
  unlisted: number;
  /** Pairs left out because the caller's `exclude` named them; absent = 0. */
  excluded?: number;
  /** No live model catalog could be read: candidates keep the names
   *  telemetry and favorites used, unverified. */
  catalogUnavailable?: boolean;
  /** Compact agent-facing rendering: one line per candidate and quota source. */
  text: string;
}

export interface ServerModelRoutingOptions {
  limit?: number;
  windowDays?: number;
  harnessId?: string;
  /** Rank exactly these `harness::provider/model` keys, used or not: a
   *  caller with its own allow-list gets their quota headroom without the
   *  shortlist's usage filter. */
  pairs?: readonly string[];
  /** `harness::provider/model` keys never to list (a person's "never
   *  delegate to"). Matched after catalog naming, so an alias row and the
   *  model it runs are the same pair. */
  exclude?: readonly string[];
  /** Harness ids never to list; their rows count as `excluded`. */
  excludeHarnesses?: readonly string[];
  order?: ServerModelRoutingOrder;
  /** Rows `text` prints when fewer than `limit` (its "+N more" counts from
   *  there): a settings page lists every row yet shows an agent's exact cut. */
  textLimit?: number;
}

/** Usage-owned delegation shortlist: favorites ∪ most-used harness/model
 *  pairs, named as the live catalogs name them and annotated with live quota
 *  headroom. */
export interface ServerModelRoutingService {
  candidates(space: SpaceContext, options?: ServerModelRoutingOptions): Promise<ServerModelRoutingReport>;
}

export const SERVER_MODEL_ROUTING =
  serverServiceKey<ServerModelRoutingService>("models.routing");

/** A person's delegation routing policy, resolved against live quota: which
 *  model each kind of delegated work goes to now, what to skip and what never
 *  to use. Provided by an optional package; the session control tool prints
 *  `brief.text`, a blank line, then the shortlist built with `exclude`. */
export interface ServerDelegationPolicyBrief {
  /** Agent-facing lines placed before the shortlist; empty when the person
   *  only reordered or trimmed the list. */
  text: string;
  /** `harness::provider/model` keys to leave out of the shortlist. */
  exclude: string[];
  /** Harness ids to leave out of the shortlist. */
  excludeHarnesses?: string[];
  /** The person's own order for the shortlist. */
  order?: ServerModelRoutingOrder;
}

export interface ServerDelegationPolicyService {
  /** Undefined when the person behind `space` leaves routing entirely to
   *  Polyth's automatic ranking. `harnessId` narrows the brief to one harness. */
  brief(space: SpaceContext, options?: { harnessId?: string }): Promise<ServerDelegationPolicyBrief | undefined>;
  /** The model the person behind `space` routes `roleId` work to right now:
   *  the first usable one of that role's chain whose `harness::provider/model`
   *  key is not in `exclude`. Undefined in Auto mode, for an unknown, disabled
   *  or empty role, and when nothing in the chain is usable. Optional: older
   *  providers answer only `brief`. */
  route?(space: SpaceContext, roleId: string, options?: { exclude?: readonly string[] }): Promise<ServerDelegationRoute | undefined>;
}

export interface ServerDelegationRoute {
  harnessId: string;
  providerID: string;
  modelID: string;
}

export const SERVER_DELEGATION_POLICY =
  serverServiceKey<ServerDelegationPolicyService>("delegation.policy");

export type ServerSessionTitleMode = "fallback" | "always";

export interface ServerSessionTitlePolicy {
  mode: ServerSessionTitleMode;
  fallbackDelayMs: number;
}

/** Optional package-owned semantic title generator. The canonical session
 * service keeps title arbitration; this service owns policy and inference. */
export interface ServerSessionTitleGenerator {
  policy(sessionId: string): Promise<ServerSessionTitlePolicy | undefined> | ServerSessionTitlePolicy | undefined;
  generate(input: { sessionId: string; prompt: string }): Promise<string | undefined>;
}

export const SERVER_SESSION_TITLE_GENERATOR =
  serverServiceKey<ServerSessionTitleGenerator>("session.title-generator");

/** Model-visible, chat-hidden context a package attaches to every turn of
 *  sessions created with its `purpose` (see `SessionProjection.purpose`).
 *  Register in `onEnable`, dispose in `onDisable`; one owner per purpose. */
export interface SessionPurposeRegistry {
  register(purpose: string, context: (session: SessionProjection) => string): Disposable;
}

export const SESSION_PURPOSES =
  serverServiceKey<SessionPurposeRegistry>("session.purposes");

/** What a start step is told about the chat being started. `author` is the
 *  server's admission fact. Derive the Space from `session`, never from the
 *  payload. */
export interface SessionStartStepContext {
  projectId: string;
  /** The first prompt of this start, when it has one. */
  firstTurnText?: string;
  author?: SessionPerson;
}

/** One package-owned step of a chat's start, fed by
 *  `SessionStartRequest.extensions[id]`. It replaces a client request that
 *  used to follow session creation. */
export interface SessionStartStep {
  /** Reject a malformed payload before anything is created. */
  validate?(payload: JsonObject, ctx: SessionStartStepContext): void | Promise<void>;
  /** Runs once the chat's row exists and before its first turn is queued.
   *  Idempotent: a resent start runs it again. A throw fails the start. */
  run(payload: JsonObject, ctx: SessionStartStepContext & { session: SessionProjection }): Promise<void>;
}

/** Register in `onEnable`, dispose in `onDisable`; one owner per id. */
export interface SessionStartStepRegistry {
  register(id: string, step: SessionStartStep): Disposable;
}

export const SESSION_START_STEPS =
  serverServiceKey<SessionStartStepRegistry>("session.start-steps");

/** Package-owned, model-visible sections appended to the deployment-wide
 *  global behavior every harness receives. `section()` is read synchronously
 *  whenever behavior is projected; return "" to contribute nothing. Call
 *  `changed()` after the section's content changes so harnesses re-project.
 *  Register in `onEnable`, dispose in `onDisable`; one owner per id. */
export interface ServerBehaviorSectionRegistry {
  register(id: string, section: () => string): Disposable;
  changed(): Promise<void>;
}

export const SERVER_BEHAVIOR_SECTIONS =
  serverServiceKey<ServerBehaviorSectionRegistry>("behavior.sections");

/** What a turn-context contributor is told about the admitted turn. `space` is
 *  the server-resolved Space scope (never client-supplied); `worktreePath` is
 *  the turn's checkout for local projects, else undefined. */
export interface TurnContextInput {
  readonly space: SpaceContext;
  readonly sessionId: string;
  readonly projectId: string;
  /** The admitted message's author (the people block's "Speaking now");
   *  undefined for a system/agent-originated send. Per-person data must be
   *  filtered to this person, and omitted when it is undefined. */
  readonly userId: string | undefined;
  readonly worktreePath: string | undefined;
}

/** Returns one complete `<polyth-…>…</polyth-…>` block, or "" for nothing. */
export type TurnContextContributor = (input: TurnContextInput) => string | Promise<string>;

/** Package-owned, model-visible per-turn blocks, collected when Polyth admits a
 *  user message and persisted with it before runtime delivery (like the people
 *  and memory blocks). Slow or failing contributors are skipped; the total
 *  budget is 150 ms and the combined text is capped at 2 KB. Register in
 *  `onEnable` (resolve the service lazily), dispose in `onDisable`. */
export interface TurnContextRegistry {
  register(contributor: TurnContextContributor): Disposable;
}

export const TURN_CONTEXT = serverServiceKey<TurnContextRegistry>("turn.context");

/** Server-owned application surface exposed to controlled browser packages.
 *
 * The returned origins are network reachability exceptions only: the
 * operator-declared canonical identity origin, plus the loopback login origin
 * for a local-trusted deployment while the public listener requires ordinary
 * UI authentication and an isolated browser therefore cannot inherit ambient
 * loopback authority. They do not authenticate the browser or confer a Space
 * identity.
 */
export interface ServerApplicationSurface {
  controlledBrowserSelfOrigins(): readonly string[];
}

export const SERVER_APPLICATION_SURFACE =
  serverServiceKey<ServerApplicationSurface>("server.application-surface");

export function createServerServiceRegistry(): ServerServiceRegistry {
  const services = new Map<string, unknown>();
  return {
    provide(key, service) {
      if (services.has(key.id)) throw err("conflict", `server service already provided: ${key.id}`);
      services.set(key.id, service);
    },
    get: <T>(key: CapabilityKey<T>) => services.get(key.id) as T | undefined,
    require<T>(key: CapabilityKey<T>): T {
      if (!services.has(key.id)) throw err("not-found", `server service not provided: ${key.id}`);
      return services.get(key.id) as T;
    },
    ids: () => [...services.keys()].sort(),
  };
}

const CAPABILITY_SERVICE = serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities");
// Ids of `SPACE_SECURE_SAFE` and the host Credential Vault router (declared
// beside their users; repeated here to keep this module import-cycle free).
const SECURE_SAFE_SPACES_SERVICE = serverServiceKey("secure-safe.spaces").id;
const SECURE_SAFE_SERVICE = serverServiceKey("secure-safe").id;

// A bound registry → the package it is bound to. Only the host binds, once,
// where it builds a package host (`hostFor` / `managedPackageServices` in the
// server). Binding a bound registry again nested the vault namespace
// (`pkg.<id>:pkg.<id>:…`) and hid every secret written before, so it throws;
// the map never yields the unbound registry, so a package cannot rebind its
// view to another id.
const packageServiceOwners = new WeakMap<ServerServiceRegistry, string>();

/** Bind capability registration to the receiving package id so a plugin cannot
 * self-assert `owner: "polyth"` or harvest another package's namespace, and
 * bind Credential Vault opaque keys to the package's own namespace. Takes the
 * unbound host registry; a registry it returned cannot be bound again. */
export function bindPackageServices(
  services: ServerServiceRegistry,
  pluginId: string,
): ServerServiceRegistry {
  const owner = packageServiceOwners.get(services);
  if (owner !== undefined) {
    throw err("conflict", `package services are already bound to "${owner}"`);
  }
  const wrap = <T>(key: CapabilityKey<T>, value: T): T => {
    if (key.id === SECURE_SAFE_SERVICE) {
      return packageScopedSecureSafe(value as SecureSafeService, pluginId) as T;
    }
    if (key.id === SECURE_SAFE_SPACES_SERVICE) {
      const registry = value as { forSpace(space: SpaceContext): SecureSafeService; forSpaceId(spaceId: string): SecureSafeService | undefined };
      return {
        forSpace: (space: SpaceContext) => packageScopedSecureSafe(registry.forSpace(space), pluginId),
        forSpaceId: (spaceId: string) => {
          const safe = registry.forSpaceId(spaceId);
          return safe ? packageScopedSecureSafe(safe, pluginId) : undefined;
        },
      } as T;
    }
    if (key.id !== CAPABILITY_SERVICE.id) return value;
    const registry = value as AgentCapabilityContributionRegistry;
    const bound: AgentCapabilityContributionRegistry = {
      register(_owner, contribution) {
        return registry.register(pluginId, {
          ...contribution,
          descriptor: { ...contribution.descriptor, owner: pluginId },
        });
      },
      list: () => registry.list().filter((item) => item.descriptor.owner === pluginId),
      resolve: (context) => registry.resolve(context).filter((item) => item.owner === pluginId),
      contribution: (id) => registry.contribution(id)?.descriptor.owner === pluginId
        ? registry.contribution(id)
        : undefined,
      executor: (_id) => undefined,
    };
    return bound as T;
  };
  const packageServices: ServerServiceRegistry = {
    provide: (key, service) => services.provide(key, service),
    get(key) {
      const value = services.get(key);
      return value === undefined ? undefined : wrap(key, value);
    },
    require(key) {
      return wrap(key, services.require(key));
    },
    ids: () => services.ids(),
  };
  packageServiceOwners.set(packageServices, pluginId);
  return packageServices;
}

/** Fail closed when a host hands package code services that the host did not
 * bind to that package (unbound, or bound to another id). */
export function assertPackageServices(services: ServerServiceRegistry, pluginId: string): void {
  const owner = packageServiceOwners.get(services);
  if (owner !== pluginId) {
    throw err(
      "invalid-input",
      owner === undefined
        ? `services for "${pluginId}" are not bound to the package`
        : `services for "${pluginId}" are bound to "${owner}"`,
    );
  }
}

/** The host handed to every discovered workspace package. Extends the trusted
 *  plugin host with the shared core services the composition root constructs,
 *  so cross-dependent packages resolve autonomously instead of being hand-wired
 *  in `packages/server/src/index.ts`. */
export interface ServerPackageHost extends TrustedServerPluginHost {
  /**
   * Tenancy seam. A package should NOT answer "who is the user / which Space /
   * where is my data / may this be accessed" for itself — it receives an
   * already-validated `SpaceContext` on every request (`rc.space`) and asks the
   * host for the rest:
   *
   *   host.spaceStorage(rc.space).packageDir(id)  // its own dir in that Space
   *   host.spaceStorage(rc.space).path(relative)  // validated, escape-proof
   *   host.deployment                             // trusted vs hosted profile
   *
   * `storageDir` (inherited) stays the SHARED, non-tenant root. It is correct
   * for genuinely deployment-wide state (a binary cache, a trusted registry)
   * and wrong for anything a Space owns. Packages still holding tenant state
   * there are being migrated; new tenant state goes through `spaceStorage`.
   */
  spaceStorage(ctx: SpaceContext): SpaceStorage;
  /** Mint the canonical non-human context for trusted background work in one
   * known Space. The host, not a feature package, owns storage-path and
   * authority resolution; callers must first derive the Space from a
   * canonical resource such as a project or session. */
  systemSpaceContext(spaceId: string): SpaceContext;
  /** The canonical context of one person in one Space, for trusted work done
   * on their behalf — an agent acting for the person who sent the turn sees
   * only the chats that person can open. Undefined unless they are an active
   * member (and on installations with a single person). Take the person from
   * server state such as a session's actor, never from request input. */
  personSpaceContext?(userId: string, spaceId: string): SpaceContext | undefined;
  /** What a chat may reach: whose private chat it is and who reads it. The only
   * source for granting a chat a person's notes; undefined means nothing
   * personal exists to reach. */
  sessionPrivacy?(spaceId: string, sessionId: string): SessionPrivacy | undefined;
  /** Record that the agent of this chat read someone's personal notes. Such a
   * chat can no longer be opened to others (Spaces §14.6). */
  markPersonalContext?(sessionId: string): Promise<void>;
  /** Person-owned data (connected accounts, §14.4): storage and secrets under
   * `people/<userId>`, outside every Space, bound to this package's id. The
   * server always provides it; test hosts may omit it. Pick whose account to
   * use with `resolveConnectionOwner`. */
  people?: PeopleHost;
  /** Resolve tenant-scoped core services inside request handlers. */
  forSpace(ctx: SpaceContext): { projects: ProjectService; sessions: SessionService };
  /** Deployment/security profile. Branch on this instead of ad-hoc
   *  `if (cloud)` checks — see `allowsHostFilesystemBrowsing`,
   *  `allowsTenantPackagesInControlPlane`, and `allowsInteractiveProviderAuth`
   *  in @polyth/contracts. */
  deployment: DeploymentProfile;
  /** The version this server reports in `/api/health` (`X.Y.Z`,
   *  `X.Y.N-nightly`). Absent on hosts older than this field. */
  version?: string;
  projects: ProjectService;
  /** Canonical session service. The reference is stable, but the service is
   *  composed AFTER package load — capture it in closures freely, never invoke
   *  its methods while `registerPackage` runs. */
  sessions: SessionService;
  /** Append-only session event store. Appends here are NOT broadcast; use
   *  `events.append` for the persist-then-broadcast pattern. */
  store: SessionPersistence & RuntimeMutationStore;
  broadcast: ServerBroadcast;
  runtimes: ServerRuntimePool;
  /** Bound to `pluginId` by the host (`bindPackageServices`); the loader
   *  rejects a host whose services are unbound or bound to another id. */
  services: ServerServiceRegistry;
  /** Persist an event to the session log, then broadcast it. Pass
   *  `producerPlugin`/`ignorable` opts exactly as the feature requires. */
  events: {
    append(
      sessionId: string,
      type: string,
      data: JsonObject,
      opts?: AppendEventOptions,
    ): Promise<SessionEvent>;
  };
  /** One-shot cheap-model completion on a throwaway backend session (never a
   *  user session; never written to the canonical log). */
  oneShot(runtime: AgentRuntime, opts: ServerOneShotOptions): Promise<string>;
  /** Lightweight utility inference. Uses a direct provider request whenever
   * supported; oneShot is only a compatibility fallback. */
  smallModelComplete(runtime: AgentRuntime, opts: ServerSmallModelOptions): Promise<ServerSmallModelResult>;
  smallModelInputBudget(runtime: AgentRuntime, model: ModelRef | undefined, maxOutputTokens: number): Promise<number>;
  /** Account-configured cheap model for auditors/summaries, including its
   * owning harness. Omit userId only for background work that has no requester. */
  smallModel(userId?: string): (ModelRef & { harnessId?: string }) | undefined;
  /** Resolve a session's project runtime + cwd/model/agent context. */
  resolveSessionRuntime(sessionId: string): Promise<SessionRuntimeBinding>;
  /** Mount a kernel plugin on the composition root; dispose to unmount. */
  loadPlugin(plugin: Plugin): Promise<Disposable>;
  /** Defer work until the gateway's HTTP server exists (e.g. attaching a WS
   *  upgrade channel). Callbacks registered during package load run before the
   *  core session gateway claims `/ws` upgrades, preserving upgrade priority. */
  onHttpServer(cb: (ctx: HttpServerContext) => void): void;
  /** Re-run HTTP-server callbacks against an additional listener (tunnel ingress). */
  attachHttpChannels(ctx: HttpServerContext): void;
  /** Start the canonical private Polyth Link HTTP/WS ingress. */
  startTunnelIngress(opts: {
    socketPath: string;
    secret: string;
    lookup(connectionId: string): Extract<RequestIngress, { kind: "polyth-link" }> | null;
  }): Promise<{ close(): Promise<void> }>;
  /** Enabled package remote-access policies plus whatever the registry currently holds. */
  remotePolicies(): ReadonlyArray<{ owner: string; policy: RemoteAccessPolicy }>;
  /** Tunnel ingress supplies the live paired-device principal. Never reads headers. */
  attachPairedDeviceResolver(
    resolver: (ingress: Extract<RequestIngress, { kind: "polyth-link" }>) => AuthPrincipal | null,
  ): void;
  /** Close WebSocket/proxy sockets belonging to one paired device. */
  closePairedDevice(deviceId: string): void;
  pairedSockets: PairedSocketRegistry;
  /**
   * Administrative Space enumeration for the package manager.
   * Wired only when `pluginId` is `"plugins"`. Third-party packages must not call this.
   */
  packageSpaces?(): PackageSpaceAdminView[];
  /** Host-owned delegation wired only for `pluginId: "plugins"`.
   * Resolves services lazily, bound to an installed package's canonical id.
   * Managed entries receive the resulting view, never this factory. */
  managedPackageServices?: (packageId: string) => ServerServiceRegistry;
}

/** Canonical Space identity + storage for package-manager administration. */
export interface PackageSpaceAdminView {
  spaceId: string;
  storage: SpaceStorage;
}

// ---- discovery --------------------------------------------------------------------

/** Composition/infrastructure packages may never be discovered as features. */
export const INFRASTRUCTURE_PACKAGE_DIRS: ReadonlySet<string> = new Set([
  "contracts",
  "kernel",
  "session",
  "tenancy",
  "outbound",
  "server",
  "web-sdk",
  "package-sdk",
]);

export interface DiscoveredServerPackage {
  /** Directory name; doubles as the package-lifecycle / registry id. */
  id: string;
  /** package.json "name", e.g. "@polyth/<id>". */
  packageName: string;
  /** Absolute package directory. */
  dir: string;
  /** The polyth.serverEntry marker value, relative to `dir`. */
  entryPath: string;
  /** Package-owned settings/lifecycle metadata from polyth.descriptor. */
  descriptor: PackageDescriptorDto;
  /** Ids the package was installed under before (`polyth.formerIds`). The
   *  host moves their data directories to `id` once (server packageRename).
   *  Absent = none. */
  formerIds?: string[];
  /** Editions beyond standard the package ships in (`polyth.editions`).
   *  The workstation edition bundles only packages that list it. */
  editions?: string[];
}

const FORMER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FORMER_IDS = 8;

/** Validated `polyth.formerIds`: distinct package ids other than the package's
 *  own. A malformed list refuses the package, like a malformed entry path. */
function formerIdsOf(id: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FORMER_IDS
    || value.some((item) => typeof item !== "string" || !FORMER_ID.test(item) || item === id)) {
    throw err("invalid-input", `package "${id}" polyth.formerIds must list at most ${MAX_FORMER_IDS} other package ids`);
  }
  return [...new Set(value as string[])];
}

/** Validated `polyth.editions`: known optional editions only. A malformed or
 *  unknown entry refuses the package, so a typo cannot silently drop it. */
function editionsOf(id: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !OPTIONAL_EDITIONS.includes(item as never))) {
    throw err("invalid-input", `package "${id}" polyth.editions may list only ${OPTIONAL_EDITIONS.join(", ")}`);
  }
  return [...new Set(value as string[])];
}

const validEntryPath = (entry: string): boolean =>
  !!entry
  && !entry.includes("\\")
  && !isAbsolute(entry)
  && !win32.isAbsolute(entry)
  && !entry.split("/").includes("..");

const SETTINGS_GROUPS = new Set(["Workspace", "Engineering", "Customize", "System"]);
const MATURITIES = new Set(["stable", "beta", "in-progress"]);

function packageDescriptor(id: string, value: unknown): PackageDescriptorDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw err("invalid-input", `package "${id}" must declare a polyth.descriptor object`);
  }
  const descriptor = value as Record<string, unknown>;
  if (
    typeof descriptor.name !== "string" || !descriptor.name.trim()
    || typeof descriptor.description !== "string" || !descriptor.description.trim()
    || typeof descriptor.core !== "boolean"
    || typeof descriptor.enabled !== "boolean"
    || typeof descriptor.hasSettings !== "boolean"
  ) {
    throw err(
      "invalid-input",
      `package "${id}" polyth.descriptor requires name, description, core, enabled, and hasSettings`,
    );
  }
  if (
    descriptor.settingsGroup !== undefined
    && (typeof descriptor.settingsGroup !== "string"
      || !SETTINGS_GROUPS.has(descriptor.settingsGroup))
  ) {
    throw err("invalid-input", `package "${id}" polyth.descriptor.settingsGroup is invalid`);
  }
  if (
    descriptor.icon !== undefined
    && (typeof descriptor.icon !== "string" || !descriptor.icon.trim())
  ) {
    throw err("invalid-input", `package "${id}" polyth.descriptor.icon must be a non-empty string`);
  }
  if (descriptor.core && !descriptor.enabled) {
    throw err("invalid-input", `core package "${id}" must be enabled by default`);
  }
  if (descriptor.maturity !== undefined && !MATURITIES.has(descriptor.maturity as string)) {
    throw err("invalid-input", `package "${id}" polyth.descriptor.maturity is invalid`);
  }
  if ((descriptor.maturity === "in-progress" || descriptor.maturity === "beta") && descriptor.enabled) {
    throw err("invalid-input", `${descriptor.maturity} package "${id}" must be disabled by default`);
  }
  return {
    id,
    name: descriptor.name,
    description: descriptor.description,
    core: descriptor.core,
    enabled: descriptor.enabled,
    hasSettings: descriptor.hasSettings,
    ...(typeof descriptor.settingsGroup === "string"
      ? { settingsGroup: descriptor.settingsGroup as PackageDescriptorDto["settingsGroup"] }
      : {}),
    ...(typeof descriptor.icon === "string" ? { icon: descriptor.icon } : {}),
    ...(descriptor.maturity === "in-progress" || descriptor.maturity === "beta"
      ? { maturity: descriptor.maturity as "in-progress" | "beta" }
      : {}),
  };
}

/** Scan `packagesDir` for workspace packages that opt in to server discovery
 *  via a `polyth.serverEntry` package.json marker. Unmarked and unreadable
 *  packages are skipped; a marked infrastructure package or an invalid entry
 *  path is a developer error and throws. Results sort by id for determinism. */
export async function discoverServerPackages(
  packagesDir: string,
): Promise<DiscoveredServerPackage[]> {
  let entries;
  try {
    entries = await readdir(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const discovered: DiscoveredServerPackage[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    } catch {
      continue; // no package.json (or unparseable) — cannot opt in
    }
    const pkg = parsed as {
      name?: unknown;
      polyth?: { serverEntry?: unknown; descriptor?: unknown; formerIds?: unknown; editions?: unknown };
    } | null;
    const entryPath = pkg?.polyth?.serverEntry;
    if (entryPath === undefined) continue;
    if (INFRASTRUCTURE_PACKAGE_DIRS.has(entry.name)) {
      throw err(
        "invalid-input",
        `infrastructure package "${entry.name}" must not declare polyth.serverEntry`,
      );
    }
    if (typeof entryPath !== "string" || !validEntryPath(entryPath)) {
      throw err(
        "invalid-input",
        `package "${entry.name}" polyth.serverEntry must be a relative path without ".." or backslashes`,
      );
    }
    discovered.push({
      id: entry.name,
      packageName: typeof pkg?.name === "string" ? pkg.name : `@polyth/${entry.name}`,
      dir,
      entryPath,
      descriptor: packageDescriptor(entry.name, pkg?.polyth?.descriptor),
      formerIds: formerIdsOf(entry.name, pkg?.polyth?.formerIds),
      editions: editionsOf(entry.name, pkg?.polyth?.editions),
    });
  }
  // A former id that names a package present now is that package's own id:
  // its data is never taken over.
  const present = new Set(discovered.map((pkg) => pkg.id));
  for (const pkg of discovered) pkg.formerIds = (pkg.formerIds ?? []).filter((former) => !present.has(former));
  return discovered.sort((a, b) => a.id.localeCompare(b.id));
}

// ---- loader -----------------------------------------------------------------------

const inside = (base: string, candidate: string): boolean =>
  candidate === base || candidate.startsWith(base + sep);

/** Import a discovered package's serverEntry and run its registerPackage
 *  factory. The entry must stay inside the package directory and must
 *  default-export a function returning a `ServerPackage`. */
export async function loadServerPackage(
  discovered: DiscoveredServerPackage,
  host: ServerPackageHost,
): Promise<ServerPackage> {
  // The host binds `host.services` when it builds the package host; the loader
  // only checks it, so services are bound exactly once.
  if (host.services) assertPackageServices(host.services, host.pluginId);
  const dir = await realpath(discovered.dir);
  const requested = resolve(dir, discovered.entryPath);
  if (!inside(dir, requested)) {
    throw err("invalid-path", `server entry for "${discovered.id}" escapes its package directory`);
  }
  const entry = await realpath(requested);
  if (!inside(dir, entry)) {
    throw err("invalid-path", `server entry for "${discovered.id}" escapes its package directory`);
  }
  if (!(await stat(entry)).isFile()) {
    throw err("invalid-input", `server entry for "${discovered.id}" must resolve to a file`);
  }

  const loaded = await import(pathToFileURL(entry).href) as { default?: unknown };
  if (typeof loaded.default !== "function") {
    throw err(
      "invalid-input",
      `server entry for "${discovered.id}" must default-export a registerPackage(host) function`,
    );
  }

  const pkg = await (loaded.default as ServerPackageFactory)(host);
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    throw err("invalid-input", `registerPackage for "${discovered.id}" must return a ServerPackage object`);
  }
  for (const field of ["routes", "onEnable", "onDisable", "stopIngress"] as const) {
    if (pkg[field] !== undefined && typeof pkg[field] !== "function") {
      throw err(
        "invalid-input",
        `registerPackage for "${discovered.id}" returned a non-function "${field}"`,
      );
    }
  }
  if (pkg.remoteAccess !== undefined) {
    if (!pkg.remoteAccess || typeof pkg.remoteAccess !== "object" || Array.isArray(pkg.remoteAccess)) {
      throw err("invalid-input", `registerPackage for "${discovered.id}" returned invalid remoteAccess`);
    }
  }
  return pkg;
}
