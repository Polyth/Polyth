/** Browser-safe contracts for the project-memory feature.
 *
 * This file intentionally has no Node imports or runtime side effects. The
 * server-only MemoryScope and SQLite implementation live in memory.ts.
 */

export type MemoryMode = "auto" | "read-only" | "off";
export type MemoryLifecycle = "candidate" | "active" | "archived" | "superseded" | "forgotten";
export type MemoryEvidence = "user-stated" | "source-observed" | "test-observed" | "inferred";
export type MemoryFreshness = "current" | "needs-review" | "unknown";
export type MemoryCategory = "decision" | "convention" | "gotcha" | "procedure" | "observation";
export type MemoryHarvestStatus = "active" | "paused" | "unavailable" | "blocked";
/** Whether this project's agents may search the memory of the person's other
 * projects: never, after an approval prompt, or without one. */
export type MemoryCrossProjectRecall = "off" | "ask" | "allow";
export const MEMORY_CROSS_PROJECT_RECALL: readonly MemoryCrossProjectRecall[] = ["off", "ask", "allow"];
/** Whose memory a record is. Only `project` records are bound to a project;
 * `space`, `agent` and `person` records are Space-wide and are reached only
 * through a server-minted layer grant (see MemoryLayerGrant). */
export type MemoryLayer = "space" | "project" | "agent" | "person";
export const MEMORY_LAYERS: readonly MemoryLayer[] = ["space", "project", "agent", "person"];

/** One layer a trusted caller may read or write. The server derives grants
 * from the session's audience and actor; never from a request body or a
 * model argument. */
export type MemoryLayerGrant =
  | { layer: "project" }
  | { layer: "space" }
  | { layer: "agent"; agentId: string }
  | { layer: "person"; userId: string };

/** Who wrote a record. Absent on records saved before provenance existed. */
export type MemoryAuthor =
  | { kind: "person"; userId: string }
  | { kind: "agent"; sessionId?: string; agentId?: string }
  | { kind: "system"; via: "harvest" | "reflect" | "import" | "notebook" };

/** The person who accepted a record into recall, and when. */
export interface MemoryApproval {
  userId: string;
  at: number;
}

export interface MemoryApplicability {
  modules?: string[];
  paths?: string[];
  workingContext?: string[];
}

export interface MemorySourceRef {
  sessionId?: string;
  startSeq?: number;
  endSeq?: number;
  document?: string;
  commit?: string;
  kind: "session" | "document" | "commit" | "manual";
}

export interface MemoryPolicyDto {
  mode: MemoryMode;
  generation: string;
  settingsRevision: string;
  contextBudget: { maxRecords: number; maxBytes: number; maxTokens?: number };
  harvesting: MemoryHarvestStatus;
  utilityModel?: { providerID: string; modelID: string; harnessId?: string };
  utilityAllowlist: Array<{ providerID: string; modelID: string }>;
  utilityStatus: "disabled" | "ready" | "unavailable" | "blocked";
  utilityBudget: { maxCalls: number; usedCalls: number; reservedCalls: number; remainingCalls: number };
  utilityModelAllowed: boolean;
  consentRequired: boolean;
  blockWithoutMemory: boolean;
  reviewPolicy: "manual" | "low-risk-auto-active";
  exclusions: { sessions: string[]; sources: string[]; paths: string[] };
  /** Absent on servers that predate cross-project recall (treat as `ask`). */
  crossProjectRecall?: MemoryCrossProjectRecall;
  updatedAt: number;
}

export interface MemoryRecordDto {
  id: string;
  projectId: string;
  title: string;
  body: string;
  category: MemoryCategory;
  tags: string[];
  aliases: string[];
  applicability: MemoryApplicability;
  sources: MemorySourceRef[];
  lifecycle: MemoryLifecycle;
  evidence: MemoryEvidence;
  freshness: MemoryFreshness;
  pinned: boolean;
  userLocked: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Absent = `project` (records from before layers). */
  layer?: MemoryLayer;
  /** The agent id or person id of an `agent`/`person` record. */
  ownerId?: string;
  authoredBy?: MemoryAuthor;
  approvedBy?: MemoryApproval;
}

export interface MemoryListItemDto extends Omit<MemoryRecordDto, "body" | "sources" | "applicability"> {
  snippet: string;
  bodyBytes: number;
  sourceCount: number;
}

export interface MemoryListPage {
  items: MemoryListItemDto[];
  total: number;
  cursor?: string;
  policy: MemoryPolicyDto;
}

export interface MemoryCreateInput {
  projectId: string;
  title: string;
  body: string;
  category?: MemoryCategory;
  tags?: string[];
  aliases?: string[];
  applicability?: MemoryApplicability;
  sources?: MemorySourceRef[];
  lifecycle?: MemoryLifecycle;
  evidence?: MemoryEvidence;
  freshness?: MemoryFreshness;
  pinned?: boolean;
  userLocked?: boolean;
  idempotencyKey?: string;
  requestFingerprint?: string;
}

export interface MemoryPatchInput {
  id: string;
  projectId: string;
  expectedRevision: number;
  patch: Partial<Pick<MemoryRecordDto, "title" | "body" | "category" | "tags" | "aliases" | "applicability" | "sources" | "freshness" | "lifecycle" | "pinned" | "userLocked">>;
  idempotencyKey?: string;
  requestFingerprint?: string;
}

export interface MemoryPolicyPatchInput {
  projectId: string;
  expectedSettingsRevision: string;
  patch: Partial<Pick<MemoryPolicyDto, "mode" | "contextBudget" | "utilityModel" | "utilityAllowlist" | "utilityStatus" | "utilityModelAllowed" | "consentRequired" | "blockWithoutMemory" | "reviewPolicy" | "exclusions" | "crossProjectRecall">> & { utilityBudget?: { maxCalls: number } };
}

export interface MemoryRecallInput {
  projectId: string;
  intent: string;
  modules?: string[];
  paths?: string[];
  error?: string;
  workingContext?: string[];
  maxRecords?: number;
  maxBytes?: number;
  maxTokens?: number;
}

export interface MemorySelectedItem {
  memoryId: string;
  revision: number;
  digest: string;
  reason: string;
  text: string;
  truncated?: boolean;
}

export interface MemoryContribution {
  status: "selected" | "empty" | "degraded" | "unavailable" | "blocked";
  requiresMemory?: boolean;
  modelVisibleText?: string;
  selected: MemorySelectedItem[];
  omittedCount: number;
  estimate: { bytes: number; tokens?: number; estimated: boolean };
  dataRevision: string;
  settingsRevision: string;
  generation: string;
  digest: string;
  reasons: string[];
}

export interface MemoryReceiptDto {
  operationId: string;
  status: "committed" | "duplicate" | "conflict" | "denied" | "skipped";
  memoryId?: string;
  revision?: number;
  generation: string;
  digest?: string;
  message?: string;
}

export interface MemoryHarvestJobDto {
  jobKey: string;
  spaceId: string;
  projectId: string;
  sessionId: string;
  sourceStartSeq: number;
  sourceEndSeq: number;
  sourceDigest: string;
  policyGeneration: string;
  extractorVersion: string;
  status: "pending" | "leased" | "processed" | "skipped" | "failed" | "denied" | "stale";
  attempts: number;
  leaseExpiresAt?: number;
  nextAttemptAt?: number;
  receiptId?: string;
  checkpointDigest?: string;
  errorCode?: string;
}

export interface MemoryExport {
  format: "memory-json-v1";
  projectId: string;
  generation: string;
  exportedAt: number;
  records: MemoryRecordDto[];
}

export type MemoryImportMode = "merge" | "replace";

export interface MemoryImportPreview {
  duplicates: number;
  conflicts: number;
  invalid: number;
}
