import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type {
  MemoryApplicability,
  MemoryApproval,
  MemoryAuthor,
  MemoryCategory,
  MemoryContribution,
  MemoryCreateInput,
  MemoryCrossProjectRecall,
  MemoryEvidence,
  MemoryExport,
  MemoryFreshness,
  MemoryHarvestJobDto,
  MemoryImportMode,
  MemoryImportPreview,
  MemoryLayer,
  MemoryLayerGrant,
  MemoryLifecycle,
  MemoryListItemDto,
  MemoryListPage,
  MemoryMode,
  MemoryPatchInput,
  MemoryPolicyDto,
  MemoryPolicyPatchInput,
  MemoryRecallInput,
  MemoryReceiptDto,
  MemoryRecordDto,
  MemorySourceRef,
} from "./memoryContracts.ts";

export type { MemoryApplicability, MemoryApproval, MemoryAuthor, MemoryCategory, MemoryContribution, MemoryCreateInput,
  MemoryCrossProjectRecall, MemoryEvidence, MemoryExport, MemoryFreshness, MemoryHarvestJobDto, MemoryImportMode, MemoryImportPreview, MemoryLayer, MemoryLayerGrant, MemoryLifecycle,
  MemoryListItemDto, MemoryListPage, MemoryMode, MemoryPatchInput, MemoryPolicyDto,
  MemoryPolicyPatchInput, MemoryRecallInput, MemoryReceiptDto, MemoryRecordDto, MemorySourceRef } from "./memoryContracts.ts";

/** Trusted identity minted by the Space gateway. Never construct this from a
 * request body; future route handlers must receive it from rc.space. */
export interface MemoryScope {
  spaceId: string;
  projectId: string;
  principalId: string;
  /** Layers this caller may read and write. Absent = the project layer only,
   * which is everything a store held before layers existed. */
  layers?: readonly MemoryLayerGrant[];
}

/** Trusted write options. Kept out of MemoryCreateInput, which route handlers
 * build from request bodies, so a client can never pick a layer or an author. */
export interface MemoryWriteOptions {
  /** Target layer; must be one of the scope's grants. Absent = project. */
  placement?: MemoryLayerGrant;
  authoredBy?: MemoryAuthor;
  /** The person accepting the record; recorded only when it is created active. */
  approver?: { userId: string };
}

export interface MemoryForgetInput {
  projectId: string;
  id: string;
  expectedRevision: number;
  sourceKeys?: string[];
}

export interface MemoryJobInput {
  jobKey: string;
  spaceId: string;
  projectId: string;
  sessionId: string;
  sourceStartSeq: number;
  sourceEndSeq: number;
  sourceDigest: string;
  policyGeneration: string;
  extractorVersion: string;
  nextAttemptAt?: number;
}

export interface MemoryHarvestCursor {
  sessionId: string;
  nextSeq: number;
  policyGeneration: string;
  checkpointDigest?: string;
}

export interface MemoryHarvestRecordInput extends Omit<MemoryCreateInput, "projectId" | "idempotencyKey" | "requestFingerprint"> {
  idempotencyKey: string;
  requestFingerprint: string;
}

export interface MemoryUtilityReservation {
  reservationId: string;
  generation: string;
  maxOutputTokens: number;
}

export interface MemoryStore {
  getPolicy(scope: MemoryScope): MemoryPolicyDto;
  updatePolicy(scope: MemoryScope, input: MemoryPolicyPatchInput): MemoryPolicyDto;
  list(scope: MemoryScope, query?: { lifecycle?: MemoryLifecycle; q?: string; limit?: number; offset?: number }): MemoryListPage;
  /** Agent-facing search with recall's semantics: active records only, any
   * query term may match, ranked like recall, policy exclusions applied.
   * `list` keeps the management page's substring filter over every lifecycle. */
  search(scope: MemoryScope, query: { q: string; limit?: number }): MemoryListPage;
  /** `search` over the project layer of several projects of this Space, ranked
   * together. The caller has already checked that the person may open every
   * listed project; a project whose memory is off, or that never enabled it,
   * is skipped and its exclusions apply. */
  searchProjects(scope: MemoryScope, query: { q: string; projectIds: readonly string[]; limit?: number }): { items: MemoryListItemDto[]; total: number; searchedProjectIds: string[] };
  get(scope: MemoryScope, id: string): MemoryRecordDto | undefined;
  create(scope: MemoryScope, input: MemoryCreateInput, options?: MemoryWriteOptions): MemoryReceiptDto;
  update(scope: MemoryScope, input: MemoryPatchInput, actor?: "user" | "agent" | "system"): MemoryReceiptDto;
  /** `approver` is recorded as `approvedBy` when the record becomes active. */
  review(scope: MemoryScope, id: string, expectedRevision: number, lifecycle: Extract<MemoryLifecycle, "active" | "candidate" | "archived" | "superseded">, approver?: { userId: string }): MemoryReceiptDto;
  restore(scope: MemoryScope, id: string, expectedRevision: number, sourceRevision: number): MemoryReceiptDto;
  forget(scope: MemoryScope, input: MemoryForgetInput): MemoryReceiptDto;
  clear(scope: MemoryScope, expectedGeneration: string): MemoryReceiptDto;
  recall(scope: MemoryScope, input: MemoryRecallInput): MemoryContribution;
  enqueueHarvest(scope: MemoryScope, input: MemoryJobInput): MemoryHarvestJobDto;
  harvestCursor(scope: MemoryScope, sessionId: string): MemoryHarvestCursor | undefined;
  resetHarvestCursor(scope: MemoryScope, sessionId: string, policyGeneration: string, nextSeq: number): MemoryHarvestCursor;
  claimHarvest(scope: MemoryScope, owner: string, leaseMs?: number, now?: number): MemoryHarvestJobDto | undefined;
  completeHarvest(scope: MemoryScope, jobKey: string, owner: string, receiptId: string, checkpointDigest: string): boolean;
  commitHarvest(scope: MemoryScope, jobKey: string, owner: string, policyGeneration: string, records: MemoryHarvestRecordInput[], receiptId: string, checkpointDigest: string, nextSeq: number): { committed: number; duplicates: number };
  skipHarvest(scope: MemoryScope, jobKey: string, owner: string, policyGeneration: string, checkpointDigest: string, nextSeq: number): boolean;
  reserveUtilityCall(scope: MemoryScope, maxOutputTokens: number): MemoryUtilityReservation;
  reconcileUtilityCall(scope: MemoryScope, reservationId: string, outcome: "consumed" | "released"): void;
  failHarvest(scope: MemoryScope, jobKey: string, owner: string, errorCode: string, retryAt?: number, terminalStatus?: "pending" | "failed" | "denied"): boolean;
  exportProject(scope: MemoryScope, options?: { includeCandidates?: boolean; includeArchived?: boolean; includeHistory?: boolean }): MemoryExport;
  importPreview(scope: MemoryScope, input: MemoryExport): MemoryImportPreview;
  importRecords(scope: MemoryScope, input: MemoryExport, mode?: MemoryImportMode): MemoryReceiptDto;
  close(): void;
}

interface MemoryRow {
  id: string;
  space_id: string;
  project_id: string;
  title: string;
  body: string;
  category: string;
  tags: string;
  aliases: string;
  applicability: string;
  sources: string;
  lifecycle: string;
  evidence: string;
  freshness: string;
  pinned: number;
  user_locked: number;
  revision: number;
  created_at: number;
  updated_at: number;
  layer: string;
  owner_id: string;
  authored_by: string | null;
  approved_by: string | null;
}

interface PolicyRow {
  space_id: string;
  project_id: string;
  mode: string;
  generation: string;
  settings_revision: number;
  max_records: number;
  max_bytes: number;
  max_tokens: number | null;
  harvesting: string;
  utility_model: string | null;
  utility_allowlist: string;
  utility_status: string;
  utility_max_calls: number;
  utility_used_calls: number;
  utility_reserved_calls: number;
  utility_model_allowed: number;
  consent_required: number;
  block_without_memory: number;
  review_policy: string;
  exclusions: string;
  cross_project: string;
  updated_at: number;
}

interface JobRow {
  job_key: string;
  space_id: string;
  project_id: string;
  session_id: string;
  source_start_seq: number;
  source_end_seq: number;
  source_digest: string;
  policy_generation: string;
  extractor_version: string;
  status: string;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  next_attempt_at: number | null;
  receipt_id: string | null;
  checkpoint_digest: string | null;
  error_code: string | null;
}

const MAX = { title: 160, bodyBytes: 8 * 1024, array: 12, sources: 8, tag: 80, path: 512 } as const;
const MAX_RECALL_RECORDS = 8;
const MAX_RECALL_BYTES = 6 * 1024;
const categories = new Set<MemoryCategory>(["decision", "convention", "gotcha", "procedure", "observation"]);
const lifecycles = new Set<MemoryLifecycle>(["candidate", "active", "archived", "superseded", "forgotten"]);
const evidence = new Set<MemoryEvidence>(["user-stated", "source-observed", "test-observed", "inferred"]);
const freshness = new Set<MemoryFreshness>(["current", "needs-review", "unknown"]);
const crossProjectValues = new Set<MemoryCrossProjectRecall>(["off", "ask", "allow"]);
const MAX_SEARCH_PROJECTS = 200;
const RANKED_ROWS = 64;

const fail = (message: string, code = "invalid-input"): never => {
  throw Object.assign(new Error(message), { code });
};
const json = <T>(value: T): string => JSON.stringify(value);
const parse = <T>(value: string, fallback: T): T => {
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const nowDefault = () => Date.now();

const tx = <T>(db: DatabaseSync, work: () => T): T => {
  db.exec("BEGIN IMMEDIATE");
  try { const result = work(); db.exec("COMMIT"); return result; }
  catch (error) { try { db.exec("ROLLBACK"); } catch { /* preserve original error */ } throw error; }
};

const boundedStrings = (value: unknown, field: string, max: number = MAX.array, itemMax: number = MAX.tag): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array of strings`);
  const values = value as unknown[];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    if (typeof item !== "string") fail(`${field} must contain strings`);
    const normalized = (item as string).trim().slice(0, itemMax);
    if (normalized && !seen.has(normalized)) { seen.add(normalized); out.push(normalized); }
  }
  if (out.length > max) fail(`${field} exceeds ${max} items`);
  return out;
};

const applicabilityOf = (value: unknown): MemoryApplicability => {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("applicability must be an object");
  const input = value as Record<string, unknown>;
  return {
    ...(input.modules !== undefined ? { modules: boundedStrings(input.modules, "applicability.modules", MAX.array, MAX.path) } : {}),
    ...(input.paths !== undefined ? { paths: boundedStrings(input.paths, "applicability.paths", MAX.array, MAX.path) } : {}),
    ...(input.workingContext !== undefined ? { workingContext: boundedStrings(input.workingContext, "applicability.workingContext", MAX.array, MAX.path) } : {}),
  };
};

const sourcesOf = (value: unknown): MemorySourceRef[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("sources must be an array");
  const values = value as unknown[];
  if (values.length > MAX.sources) fail(`sources exceeds ${MAX.sources} items`);
  return values.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("source must be an object");
    const item = entry as Record<string, unknown>;
    const kind = item.kind as MemorySourceRef["kind"];
    if (kind !== "session" && kind !== "document" && kind !== "commit" && kind !== "manual") fail("source kind is invalid");
    if (item.sessionId !== undefined && (typeof item.sessionId !== "string" || !item.sessionId.trim())) fail("source sessionId is invalid");
    for (const key of ["startSeq", "endSeq"] as const) {
      if (item[key] !== undefined && (!Number.isSafeInteger(item[key]) || Number(item[key]) <= 0)) fail(`source ${key} is invalid`);
    }
    return {
      kind,
      ...(typeof item.sessionId === "string" ? { sessionId: item.sessionId.trim().slice(0, MAX.path) } : {}),
      ...(typeof item.document === "string" ? { document: item.document.trim().slice(0, MAX.path) } : {}),
      ...(typeof item.commit === "string" ? { commit: item.commit.trim().slice(0, MAX.path) } : {}),
      ...(item.startSeq !== undefined ? { startSeq: Number(item.startSeq) } : {}),
      ...(item.endSeq !== undefined ? { endSeq: Number(item.endSeq) } : {}),
    };
  });
};

const scopeCheck = (scope: MemoryScope): void => {
  if (!scope || typeof scope !== "object" || !scope.spaceId?.trim() || !scope.projectId?.trim() || !scope.principalId?.trim()) fail("validated Space, project, and principal are required", "forbidden");
};

const MAX_GRANTS = 8;
const PROJECT_GRANT: readonly MemoryLayerGrant[] = Object.freeze([{ layer: "project" } as const]);
const ownerOf = (grant: MemoryLayerGrant): string =>
  grant.layer === "agent" ? grant.agentId : grant.layer === "person" ? grant.userId : "";
const grantKey = (grant: MemoryLayerGrant): string => `${grant.layer}:${ownerOf(grant)}`;

/** The scope's grants, validated. A malformed grant refuses the whole call
 * rather than silently widening or narrowing what the caller sees. */
const grantsOf = (scope: MemoryScope): readonly MemoryLayerGrant[] => {
  if (scope.layers === undefined) return PROJECT_GRANT;
  if (!Array.isArray(scope.layers) || scope.layers.length > MAX_GRANTS) fail("memory layer grants are invalid", "forbidden");
  const seen = new Map<string, MemoryLayerGrant>();
  for (const grant of scope.layers) {
    const layer = (grant as { layer?: unknown })?.layer;
    if (layer !== "project" && layer !== "space" && layer !== "agent" && layer !== "person") fail("memory layer grant is invalid", "forbidden");
    if (layer === "agent" || layer === "person") {
      const owner = ownerOf(grant);
      if (typeof owner !== "string" || !owner.trim() || owner.length > 128) fail("memory layer grant owner is invalid", "forbidden");
    }
    seen.set(grantKey(grant), grant);
  }
  return [...seen.values()];
};

/** Columns a new record gets for its layer. Only the project layer is bound to
 * a project; the other layers are Space-wide. */
const placementOf = (scope: MemoryScope, grant: MemoryLayerGrant): { layer: MemoryLayer; ownerId: string; projectId: string } => ({
  layer: grant.layer, ownerId: ownerOf(grant), projectId: grant.layer === "project" ? scope.projectId : "",
});

/** SQL restricting rows to the granted layers. `alias` prefixes columns. */
const layerClause = (scope: MemoryScope, alias = ""): { sql: string; params: string[] } => {
  const grants = grantsOf(scope);
  if (!grants.length) return { sql: "(0)", params: [] };
  const params: string[] = [];
  const parts = grants.map((grant) => {
    if (grant.layer === "project") { params.push(scope.projectId); return `(${alias}layer='project' AND ${alias}project_id=?)`; }
    if (grant.layer === "space") return `(${alias}layer='space')`;
    params.push(ownerOf(grant)); return `(${alias}layer='${grant.layer}' AND ${alias}owner_id=?)`;
  });
  return { sql: `(${parts.join(" OR ")})`, params };
};

const authorOf = (value: unknown): MemoryAuthor | undefined => {
  if (value === undefined) return undefined;
  const item = value as Record<string, unknown> | null;
  const id = (key: string): string | undefined => {
    const raw = item?.[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || !raw.trim() || raw.length > 128) fail(`authoredBy.${key} is invalid`);
    return (raw as string).trim();
  };
  if (item?.kind === "person") { const userId = id("userId"); if (!userId) fail("authoredBy.userId is required"); return { kind: "person", userId: userId! }; }
  if (item?.kind === "agent") {
    const sessionId = id("sessionId"); const agentId = id("agentId");
    return { kind: "agent", ...(sessionId ? { sessionId } : {}), ...(agentId ? { agentId } : {}) };
  }
  if (item?.kind === "system" && (item.via === "harvest" || item.via === "reflect" || item.via === "import" || item.via === "notebook")) return { kind: "system", via: item.via };
  return fail("authoredBy is invalid");
};

const normalizeInput = (input: MemoryCreateInput) => {
  if (!input.projectId?.trim()) fail("projectId is required");
  if (typeof input.title !== "string" || !input.title.trim()) fail("title is required");
  if (input.title.trim().length > MAX.title) fail(`title exceeds ${MAX.title} characters`);
  if (typeof input.body !== "string" || !input.body.trim()) fail("body is required");
  if (bytes(input.body) > MAX.bodyBytes) fail(`body exceeds ${MAX.bodyBytes} bytes`);
  const category = input.category ?? "observation";
  if (!categories.has(category)) fail("category is invalid");
  const itemLifecycle = input.lifecycle ?? "candidate";
  if (!lifecycles.has(itemLifecycle)) fail("memory lifecycle is invalid");
  const itemEvidence = input.evidence ?? "inferred";
  if (!evidence.has(itemEvidence)) fail("evidence is invalid");
  const itemFreshness = input.freshness ?? "unknown";
  if (!freshness.has(itemFreshness)) fail("freshness is invalid");
  return {
    title: input.title.trim(), body: input.body,
    category, tags: boundedStrings(input.tags, "tags"), aliases: boundedStrings(input.aliases, "aliases"),
    applicability: applicabilityOf(input.applicability), sources: sourcesOf(input.sources),
    lifecycle: itemLifecycle, evidence: itemEvidence, freshness: itemFreshness,
    pinned: input.pinned === true, userLocked: input.userLocked === true,
  } as const;
};

const storedJson = <T>(raw: string | null | undefined): T | undefined => raw ? parse<T | undefined>(raw, undefined) : undefined;

const itemFrom = (row: MemoryRow): MemoryRecordDto => {
  const authoredBy = storedJson<MemoryAuthor>(row.authored_by);
  const approvedBy = storedJson<MemoryApproval>(row.approved_by);
  return {
  id: row.id, projectId: row.project_id, title: row.title, body: row.body,
  category: row.category as MemoryCategory,
  tags: parse<string[]>(row.tags, []), aliases: parse<string[]>(row.aliases, []),
  applicability: parse<MemoryApplicability>(row.applicability, {}),
  sources: parse<MemorySourceRef[]>(row.sources, []), lifecycle: row.lifecycle as MemoryLifecycle,
  evidence: row.evidence as MemoryEvidence, freshness: row.freshness as MemoryFreshness,
  pinned: row.pinned === 1, userLocked: row.user_locked === 1,
  revision: Number(row.revision), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  layer: (row.layer || "project") as MemoryLayer,
  ...(row.owner_id ? { ownerId: row.owner_id } : {}),
  ...(authoredBy ? { authoredBy } : {}),
  ...(approvedBy ? { approvedBy } : {}),
  };
};

const policyFrom = (row: PolicyRow): MemoryPolicyDto => ({
  mode: row.mode as MemoryMode, generation: row.generation, settingsRevision: String(row.settings_revision),
  contextBudget: { maxRecords: Number(row.max_records), maxBytes: Number(row.max_bytes), ...(row.max_tokens === null ? {} : { maxTokens: Number(row.max_tokens) }) },
  harvesting: row.harvesting as MemoryPolicyDto["harvesting"],
  ...(row.utility_model ? { utilityModel: parse<MemoryPolicyDto["utilityModel"]>(row.utility_model, undefined) } : {}),
  utilityAllowlist: parse<MemoryPolicyDto["utilityAllowlist"]>(row.utility_allowlist, []),
  utilityStatus: row.utility_status as MemoryPolicyDto["utilityStatus"],
  utilityBudget: {
    maxCalls: Number(row.utility_max_calls),
    usedCalls: Number(row.utility_used_calls),
    reservedCalls: Number(row.utility_reserved_calls),
    remainingCalls: Math.max(0, Number(row.utility_max_calls) - Number(row.utility_used_calls) - Number(row.utility_reserved_calls)),
  },
  utilityModelAllowed: row.utility_model_allowed === 1, consentRequired: row.consent_required === 1,
  blockWithoutMemory: row.block_without_memory === 1, reviewPolicy: row.review_policy as MemoryPolicyDto["reviewPolicy"],
  exclusions: parse<MemoryPolicyDto["exclusions"]>(row.exclusions, { sessions: [], sources: [], paths: [] }),
  crossProjectRecall: crossProjectValues.has(row.cross_project as MemoryCrossProjectRecall) ? row.cross_project as MemoryCrossProjectRecall : "ask",
  updatedAt: Number(row.updated_at),
});

const listItem = (item: MemoryRecordDto): MemoryListItemDto => ({
  ...(({ body: _body, sources: _sources, applicability: _applicability, ...rest }) => rest)(item),
  snippet: item.body.replace(/\s+/g, " ").trim().slice(0, 220),
  bodyBytes: bytes(item.body), sourceCount: item.sources.length,
});

// Grammatical words should not outrank the task's subject in an OR query.
const recallStopWords = new Set("a an and are as at be been being but by can could do does for from had has have how i if in into is it its me my of on or our please should than that the their them there these they this those to was we were what when where which who will with would you your а але без був була були в від він вона вони для до з за і із й на не по про та у це цей ця чи що як".split(" "));
const queryTokens = (query: string): string[] => [...new Set(
  (query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) ?? [])
    .filter((token) => !recallStopWords.has(token)),
)].slice(0, 24);
/** Prefix stem of an inflected word, so "symptoms" also finds "symptom" and
 * "гастриту" finds "гастрит". Ukrainian and English endings are 1-3 letters;
 * keeping at least four (five for longer words) letters keeps a stem from
 * matching unrelated words. Numbers, paths and short words stay exact. */
const stemOf = (token: string): string | undefined => {
  if (!/^\p{L}+$/u.test(token)) return undefined;
  const letters = [...token];
  if (letters.length < 4) return undefined;
  const keep = letters.length >= 6 ? Math.max(5, letters.length - 3) : 4;
  return letters.slice(0, keep).join("");
};
const quoted = (token: string): string => `"${token.replaceAll('"', '""')}"`;
/** Every term matches exactly or by its stem; an exact hit scores both. */
const ftsExpression = (query: string): string => queryTokens(query).flatMap((token) => {
  const stem = stemOf(token);
  return stem ? [quoted(token), `${quoted(stem)}*`] : [quoted(token)];
}).join(" OR ").slice(0, 2_000);
/** Substring terms for the trigram index: finds "palace" inside "MemPalace"
 * and parts of compounds. Short terms would match almost every record. */
const trigramExpression = (query: string): string =>
  queryTokens(query).filter((token) => [...token].length >= 4).slice(0, 12).map(quoted).join(" OR ");
// A title or tag hit says more about a record than a passing word in its body.
const FTS_RANK = "bm25(memory_fts, 0, 0, 0, 4.0, 1.0, 2.0, 2.0)";
/** Per-term LIKE fallback used when FTS is unavailable: any term may match,
 * like the FTS `OR` query, instead of requiring the whole phrase. */
const lexicalClause = (query: string, alias = ""): { sql: string; params: string[] } | undefined => {
  const tokens = queryTokens(query).slice(0, 12);
  if (!tokens.length) return undefined;
  const params: string[] = [];
  const parts = tokens.map((token) => {
    const needle = `%${(stemOf(token) ?? token).replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    params.push(needle, needle, needle, needle);
    return `(${alias}title LIKE ? ESCAPE '\\' OR ${alias}body LIKE ? ESCAPE '\\' OR ${alias}tags LIKE ? ESCAPE '\\' OR ${alias}aliases LIKE ? ESCAPE '\\')`;
  });
  return { sql: `(${parts.join(" OR ")})`, params };
};

const sourceKeys = (sources: readonly MemorySourceRef[]): string[] => sources.map((source) => JSON.stringify(source));
/** Whether a project's recall exclusions hide this record from agents. */
export const excludedByPolicy = (item: MemoryRecordDto, exclusions: MemoryPolicyDto["exclusions"]): boolean =>
  exclusions.sessions.some((x) => item.sources.some((s) => s.sessionId === x))
  || exclusions.sources.some((x) => sourceKeys(item.sources).includes(x))
  || exclusions.paths.some((x) => item.applicability.paths?.includes(x));

const memoryEnvelope = (items: readonly MemoryContribution["selected"][number][]): string => {
  if (!items.length) return "";
  return [
    "<polyth-project-memory>",
    ...items.map((item) => `[${item.memoryId} rev ${item.revision}]\n${item.text}`),
    "</polyth-project-memory>",
  ].join("\n");
};

/** Return a UTF-8 bounded prefix that ends at a sentence/line boundary. */
const boundedEvidence = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && bytes(value.slice(0, end)) > maxBytes) end--;
  while (end > 0 && !/[.!?\n]\s*$/.test(value.slice(0, end))) end--;
  return value.slice(0, end).trimEnd();
};

export function createMemoryStore(db: DatabaseSync, expectedSpaceId?: string, now = nowDefault): MemoryStore {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS memory_meta (
      space_id TEXT PRIMARY KEY,
      data_revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS memory_policy (
      space_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('auto','read-only','off')),
      generation TEXT NOT NULL,
      settings_revision INTEGER NOT NULL DEFAULT 1,
      max_records INTEGER NOT NULL DEFAULT 6,
      max_bytes INTEGER NOT NULL DEFAULT 6144,
      max_tokens INTEGER,
      harvesting TEXT NOT NULL DEFAULT 'paused',
      utility_model TEXT,
      utility_allowlist TEXT NOT NULL DEFAULT '[]',
      utility_status TEXT NOT NULL DEFAULT 'disabled',
      utility_max_calls INTEGER NOT NULL DEFAULT 0,
      utility_used_calls INTEGER NOT NULL DEFAULT 0,
      utility_reserved_calls INTEGER NOT NULL DEFAULT 0,
      utility_model_allowed INTEGER NOT NULL DEFAULT 0,
      consent_required INTEGER NOT NULL DEFAULT 1,
      block_without_memory INTEGER NOT NULL DEFAULT 0,
      review_policy TEXT NOT NULL DEFAULT 'manual',
      exclusions TEXT NOT NULL DEFAULT '{"sessions":[],"sources":[],"paths":[]}',
      cross_project TEXT NOT NULL DEFAULT 'ask',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(space_id, project_id)
    );
    CREATE TABLE IF NOT EXISTS memory_records (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT NOT NULL,
      tags TEXT NOT NULL,
      aliases TEXT NOT NULL,
      applicability TEXT NOT NULL,
      sources TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      evidence TEXT NOT NULL,
      freshness TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      user_locked INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      layer TEXT NOT NULL DEFAULT 'project',
      owner_id TEXT NOT NULL DEFAULT '',
      authored_by TEXT,
      approved_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_records(space_id, project_id, lifecycle, updated_at);
    CREATE TABLE IF NOT EXISTS memory_revisions (
      record_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(record_id, revision)
    );
    CREATE TABLE IF NOT EXISTS memory_idempotency (
      project_id TEXT NOT NULL,
      operation_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      receipt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, operation_key)
    );
    CREATE TABLE IF NOT EXISTS memory_tombstones (
      space_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      generation TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(space_id, project_id, source_key)
    );
    CREATE TABLE IF NOT EXISTS memory_harvest_jobs (
      job_key TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source_start_seq INTEGER NOT NULL,
      source_end_seq INTEGER NOT NULL,
      source_digest TEXT NOT NULL,
      policy_generation TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      next_attempt_at INTEGER,
      receipt_id TEXT,
      checkpoint_digest TEXT,
      error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_jobs_ready ON memory_harvest_jobs(space_id, project_id, status, next_attempt_at);
    -- Claim scans only live work; terminal rows (denied/failed/done) can number
    -- in the thousands per project and must not be walked and sorted each poll.
    CREATE INDEX IF NOT EXISTS idx_memory_jobs_claimable ON memory_harvest_jobs(space_id, project_id, source_end_seq) WHERE status IN ('pending','leased');
    CREATE TABLE IF NOT EXISTS memory_harvest_cursors (
      space_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      next_seq INTEGER NOT NULL,
      policy_generation TEXT NOT NULL,
      checkpoint_digest TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(space_id, project_id, session_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      memory_id UNINDEXED, space_id UNINDEXED, project_id UNINDEXED,
      title, body, tags, aliases, tokenize='unicode61 remove_diacritics 2'
    );
  `);
  // Substring index for agent search. Triggers keep it in step with every
  // write, including writes by a server version that predates it. Optional:
  // an SQLite without the trigram tokenizer keeps word and stem matching only.
  let trigram = false;
  try {
    const text = "new.title || char(10) || new.body || char(10) || new.tags || char(10) || new.aliases";
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_tri USING fts5(
      memory_id UNINDEXED, space_id UNINDEXED, project_id UNINDEXED, text, tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS memory_fts_tri_insert AFTER INSERT ON memory_records BEGIN
      INSERT INTO memory_fts_tri(memory_id, space_id, project_id, text) VALUES(new.id, new.space_id, new.project_id, ${text});
    END;
    CREATE TRIGGER IF NOT EXISTS memory_fts_tri_update AFTER UPDATE OF title, body, tags, aliases, project_id ON memory_records BEGIN
      DELETE FROM memory_fts_tri WHERE memory_id = old.id;
      INSERT INTO memory_fts_tri(memory_id, space_id, project_id, text) VALUES(new.id, new.space_id, new.project_id, ${text});
    END;
    CREATE TRIGGER IF NOT EXISTS memory_fts_tri_delete AFTER DELETE ON memory_records BEGIN
      DELETE FROM memory_fts_tri WHERE memory_id = old.id;
    END;`);
    // Records written before the index existed are indexed once.
    const indexed = Number((db.prepare("SELECT count(*) AS count FROM memory_fts_tri").get() as { count: number }).count);
    const records = Number((db.prepare("SELECT count(*) AS count FROM memory_records").get() as { count: number }).count);
    if (indexed !== records) {
      db.exec(`BEGIN IMMEDIATE; DELETE FROM memory_fts_tri;
        INSERT INTO memory_fts_tri(memory_id, space_id, project_id, text)
          SELECT id, space_id, project_id, title || char(10) || body || char(10) || tags || char(10) || aliases FROM memory_records;
        COMMIT;`);
    }
    trigram = true;
  } catch {
    try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
    trigram = false;
  }
  const policyColumns = new Set((db.prepare("PRAGMA table_info(memory_policy)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!policyColumns.has("utility_allowlist")) db.exec("ALTER TABLE memory_policy ADD COLUMN utility_allowlist TEXT NOT NULL DEFAULT '[]'");
  if (!policyColumns.has("utility_status")) db.exec("ALTER TABLE memory_policy ADD COLUMN utility_status TEXT NOT NULL DEFAULT 'disabled'");
  if (!policyColumns.has("utility_max_calls")) db.exec("ALTER TABLE memory_policy ADD COLUMN utility_max_calls INTEGER NOT NULL DEFAULT 0");
  if (!policyColumns.has("utility_used_calls")) db.exec("ALTER TABLE memory_policy ADD COLUMN utility_used_calls INTEGER NOT NULL DEFAULT 0");
  if (!policyColumns.has("utility_reserved_calls")) db.exec("ALTER TABLE memory_policy ADD COLUMN utility_reserved_calls INTEGER NOT NULL DEFAULT 0");
  if (!policyColumns.has("cross_project")) db.exec("ALTER TABLE memory_policy ADD COLUMN cross_project TEXT NOT NULL DEFAULT 'ask'");
  // Layers and provenance (additive). Every record that predates them is a
  // project record with an unknown author.
  const recordColumns = new Set((db.prepare("PRAGMA table_info(memory_records)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!recordColumns.has("layer")) db.exec("ALTER TABLE memory_records ADD COLUMN layer TEXT NOT NULL DEFAULT 'project'");
  if (!recordColumns.has("owner_id")) db.exec("ALTER TABLE memory_records ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''");
  if (!recordColumns.has("authored_by")) db.exec("ALTER TABLE memory_records ADD COLUMN authored_by TEXT");
  if (!recordColumns.has("approved_by")) db.exec("ALTER TABLE memory_records ADD COLUMN approved_by TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_memory_layer ON memory_records(space_id, layer, owner_id, lifecycle, updated_at)");
  db.exec(`CREATE TABLE IF NOT EXISTS memory_utility_reservations (
    reservation_id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    max_output_tokens INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','consumed','released')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_utility_reservations_scope ON memory_utility_reservations(space_id, project_id, state);`);
  if (expectedSpaceId && !db.prepare("SELECT 1 FROM memory_meta WHERE space_id = ?").get(expectedSpaceId)) {
    db.prepare("INSERT INTO memory_meta(space_id, data_revision) VALUES(?, 0)").run(expectedSpaceId);
  }
  let closed = false;
  const assertOpen = () => { if (closed) fail("memory store is closed", "unavailable"); };
  const assertScope = (scope: MemoryScope): void => {
    assertOpen(); scopeCheck(scope);
    if (expectedSpaceId && scope.spaceId !== expectedSpaceId) fail("memory Space scope is invalid", "forbidden");
  };
  const bump = (scope: MemoryScope): string => {
    db.prepare("INSERT INTO memory_meta(space_id, data_revision) VALUES(?, 1) ON CONFLICT(space_id) DO UPDATE SET data_revision = data_revision + 1").run(scope.spaceId);
    const row = db.prepare("SELECT data_revision FROM memory_meta WHERE space_id = ?").get(scope.spaceId) as { data_revision: number };
    return String(row.data_revision);
  };
  const policyRow = (scope: MemoryScope): PolicyRow => {
    let row = db.prepare("SELECT * FROM memory_policy WHERE space_id = ? AND project_id = ?").get(scope.spaceId, scope.projectId) as unknown as PolicyRow | undefined;
    if (!row) {
      const t = now();
      db.prepare(`INSERT INTO memory_policy(space_id, project_id, mode, generation, review_policy, updated_at) VALUES(?, ?, 'off', ?, 'low-risk-auto-active', ?)`).run(scope.spaceId, scope.projectId, randomUUID(), t);
      row = db.prepare("SELECT * FROM memory_policy WHERE space_id = ? AND project_id = ?").get(scope.spaceId, scope.projectId) as unknown as PolicyRow;
    }
    return row;
  };
  const ensureIdempotency = (scope: MemoryScope, key: string | undefined, fingerprint: string | undefined): MemoryReceiptDto | undefined => {
    if (!key) return undefined;
    if (!fingerprint) fail("requestFingerprint is required with idempotencyKey");
    const row = db.prepare("SELECT fingerprint, receipt FROM memory_idempotency WHERE project_id = ? AND operation_key = ?").get(scope.projectId, key) as { fingerprint: string; receipt: string } | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) fail("idempotency key is already bound to another payload", "conflict");
    return { ...parse<MemoryReceiptDto>(row.receipt, { operationId: key, status: "conflict", generation: policyRow(scope).generation }), status: "duplicate" };
  };
  const saveIdempotency = (scope: MemoryScope, key: string | undefined, fingerprint: string | undefined, receipt: MemoryReceiptDto): void => {
    if (!key) return;
    db.prepare("INSERT INTO memory_idempotency(project_id, operation_key, fingerprint, receipt, created_at) VALUES(?,?,?,?,?)").run(scope.projectId, key, fingerprint!, json(receipt), now());
  };
  const updateFts = (item: MemoryRecordDto, spaceId: string): void => {
    db.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(item.id);
    db.prepare("INSERT INTO memory_fts(memory_id, space_id, project_id, title, body, tags, aliases) VALUES(?,?,?,?,?,?,?)").run(item.id, spaceId, item.projectId, item.title, item.body, item.tags.join(" "), item.aliases.join(" "));
  };
  /** Active records of `where` (columns prefixed `m.`) matching any query
   * term: pinned first, then by weighted FTS rank. Recall, agent search and
   * cross-project search share it so they never disagree. `substring` adds
   * trigram hits the word index missed, for explicit agent searches only:
   * a whole prompt would pull in every record sharing a common substring. */
  const rankedRows = (spaceId: string, where: { sql: string; params: string[] }, queryText: string, substring = false): { rows: MemoryRow[]; degraded: boolean } => {
    const fts = ftsExpression(queryText);
    let rows: MemoryRow[] | undefined;
    if (fts) {
      try {
        rows = db.prepare(`SELECT m.* FROM memory_fts f JOIN memory_records m ON m.id=f.memory_id WHERE f.space_id=? AND m.space_id=? AND ${where.sql} AND memory_fts MATCH ? AND m.lifecycle='active' ORDER BY m.pinned DESC, ${FTS_RANK} LIMIT ${RANKED_ROWS}`).all(spaceId, spaceId, ...where.params, fts) as unknown as MemoryRow[];
      } catch { rows = undefined; }
    }
    if (!rows) {
      const lexical = lexicalClause(queryText, "m.");
      if (!lexical) return { rows: [], degraded: Boolean(fts) };
      return { rows: db.prepare(`SELECT m.* FROM memory_records m WHERE m.space_id=? AND ${where.sql} AND m.lifecycle='active' AND ${lexical.sql} ORDER BY m.pinned DESC, m.updated_at DESC LIMIT ${RANKED_ROWS}`).all(spaceId, ...where.params, ...lexical.params) as unknown as MemoryRow[], degraded: true };
    }
    const tri = substring && trigram && rows.length < RANKED_ROWS ? trigramExpression(queryText) : "";
    if (tri) {
      try {
        const seen = new Set(rows.map((row) => row.id));
        const extra = db.prepare(`SELECT m.* FROM memory_fts_tri t JOIN memory_records m ON m.id=t.memory_id WHERE t.space_id=? AND m.space_id=? AND ${where.sql} AND memory_fts_tri MATCH ? AND m.lifecycle='active' ORDER BY m.pinned DESC, bm25(memory_fts_tri) LIMIT ${RANKED_ROWS}`).all(spaceId, spaceId, ...where.params, tri) as unknown as MemoryRow[];
        for (const row of extra) if (!seen.has(row.id) && rows.length < RANKED_ROWS) { seen.add(row.id); rows.push(row); }
      } catch { /* word and stem matches stand on their own */ }
    }
    return { rows, degraded: false };
  };
  const rankedActiveRows = (scope: MemoryScope, queryText: string, substring = false) => rankedRows(scope.spaceId, layerClause(scope, "m."), queryText, substring);
  /** One record by id, only when it lies in a granted layer of this Space. */
  const grantedRow = (scope: MemoryScope, id: string): MemoryRow | undefined => {
    const layers = layerClause(scope);
    return db.prepare(`SELECT * FROM memory_records WHERE id=? AND space_id=? AND ${layers.sql}`).get(id, scope.spaceId, ...layers.params) as unknown as MemoryRow | undefined;
  };
  const insertRecord = (spaceId: string, item: MemoryRecordDto, placement: { layer: MemoryLayer; ownerId: string }, authoredBy: MemoryAuthor | undefined): void => {
    db.prepare(`INSERT INTO memory_records(id,space_id,project_id,title,body,category,tags,aliases,applicability,sources,lifecycle,evidence,freshness,pinned,user_locked,revision,created_at,updated_at,layer,owner_id,authored_by,approved_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      item.id, spaceId, item.projectId, item.title, item.body, item.category, json(item.tags), json(item.aliases), json(item.applicability), json(item.sources), item.lifecycle, item.evidence, item.freshness, item.pinned ? 1 : 0, item.userLocked ? 1 : 0, item.revision, item.createdAt, item.updatedAt,
      placement.layer, placement.ownerId, authoredBy ? json(authoredBy) : null, item.approvedBy ? json(item.approvedBy) : null,
    );
  };
  const revision = (item: MemoryRecordDto, at: number): void => {
    db.prepare("INSERT INTO memory_revisions(record_id, project_id, revision, payload, created_at) VALUES(?,?,?,?,?)").run(item.id, item.projectId, item.revision, json(item), at);
  };
  // Older knowledge stores represented memory as kind='memory' rows. Migrate
  // those rows into the scoped memory tables once, preserving IDs and source
  // provenance. A scoped store is required so legacy rows cannot be assigned
  // to an ambient tenant.
  if (expectedSpaceId && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge'").get()) {
    const legacyRows = db.prepare("SELECT * FROM knowledge WHERE kind='memory'").all() as Array<Record<string, unknown>>;
    for (const legacy of legacyRows) {
      const id = typeof legacy.id === "string" ? legacy.id : "";
      const projectId = typeof legacy.project_id === "string" ? legacy.project_id : "";
      const title = typeof legacy.title === "string" ? legacy.title.trim() : "";
      const body = typeof legacy.body === "string" ? legacy.body : "";
      if (!id || !projectId || !title || title.length > MAX.title || !body || bytes(body) > MAX.bodyBytes) continue;
      const tags = parse<string[]>(typeof legacy.tags === "string" ? legacy.tags : "[]", []);
      const createdAt = Number(legacy.created_at) || now(); const updatedAt = Number(legacy.updated_at) || createdAt;
      const item: MemoryRecordDto = {
        id, projectId, title, body, category: "observation", tags: tags.slice(0, MAX.array), aliases: [], applicability: {},
        sources: [{ kind: "session", ...(typeof legacy.source_session_id === "string" && legacy.source_session_id ? { sessionId: legacy.source_session_id } : {}) }],
        lifecycle: "active", evidence: legacy.source === "user" ? "user-stated" : "source-observed", freshness: "unknown", pinned: false,
        userLocked: legacy.source === "user", revision: Math.max(1, Number(legacy.revision) || 1), createdAt, updatedAt,
      };
      db.prepare("INSERT OR IGNORE INTO memory_records(id,space_id,project_id,title,body,category,tags,aliases,applicability,sources,lifecycle,evidence,freshness,pinned,user_locked,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        item.id, expectedSpaceId, item.projectId, item.title, item.body, item.category, json(item.tags), json(item.aliases), json(item.applicability), json(item.sources), item.lifecycle, item.evidence, item.freshness, item.pinned ? 1 : 0, item.userLocked ? 1 : 0, item.revision, item.createdAt, item.updatedAt,
      );
      if (db.prepare("SELECT 1 FROM memory_revisions WHERE record_id=? AND revision=?").get(item.id, item.revision) === undefined) revision(item, item.updatedAt);
      updateFts(item, expectedSpaceId);
    }
  }

  const updateRecord = (scope: MemoryScope, input: MemoryPatchInput, actor: "user" | "agent" | "system", approvedBy?: MemoryApproval): MemoryReceiptDto => {
    assertScope(scope);
    if (input.projectId !== scope.projectId) fail("project scope mismatch", "forbidden");
    const duplicate = ensureIdempotency(scope, input.idempotencyKey, input.requestFingerprint);
    if (duplicate) return duplicate;
    const row = grantedRow(scope, input.id);
    if (!row) fail("memory record not found", "not-found");
    const loaded = row as MemoryRow;
    if (Number(loaded.revision) !== input.expectedRevision) fail("memory record changed since it was loaded", "conflict");
    if (actor !== "user" && loaded.user_locked === 1) fail("memory record is locked by the user", "forbidden");
    const current = itemFrom(loaded); const patch = input.patch;
    if (current.lifecycle === "forgotten") fail("forgotten memory requires explicit restoration", "conflict");
    if (patch.lifecycle === "forgotten") fail("use forget to create a memory tombstone");
    const next = normalizeInput({ ...current, ...patch, projectId: scope.projectId, evidence: current.evidence, freshness: patch.freshness ?? current.freshness });
    return tx(db, () => {
      const t = now(); const nextItem: MemoryRecordDto = { ...current, ...next, projectId: current.projectId, revision: current.revision + 1, updatedAt: t, userLocked: actor === "user" ? true : current.userLocked, ...(approvedBy ? { approvedBy } : {}) };
      const result = db.prepare(`UPDATE memory_records SET title=?,body=?,category=?,tags=?,aliases=?,applicability=?,sources=?,lifecycle=?,evidence=?,freshness=?,pinned=?,user_locked=?,revision=?,updated_at=?,approved_by=? WHERE id=? AND project_id=? AND space_id=? AND revision=?`).run(
        nextItem.title, nextItem.body, nextItem.category, json(nextItem.tags), json(nextItem.aliases), json(nextItem.applicability), json(nextItem.sources), nextItem.lifecycle, nextItem.evidence, nextItem.freshness, nextItem.pinned ? 1 : 0, nextItem.userLocked ? 1 : 0, nextItem.revision, t, nextItem.approvedBy ? json(nextItem.approvedBy) : null, nextItem.id, current.projectId, scope.spaceId, current.revision,
      );
      if (Number(result.changes) !== 1) fail("memory record changed since it was loaded", "conflict");
      updateFts(nextItem, scope.spaceId); revision(nextItem, t); const policy = policyRow(scope); bump(scope);
      const receipt: MemoryReceiptDto = { operationId: input.idempotencyKey ?? randomUUID(), status: "committed", memoryId: nextItem.id, revision: nextItem.revision, generation: policy.generation, digest: digest(json(nextItem)) };
      saveIdempotency(scope, input.idempotencyKey, input.requestFingerprint, receipt); return receipt;
    });
  };

  const api: MemoryStore = {
    getPolicy(scope) { assertScope(scope); return policyFrom(policyRow(scope)); },
    updatePolicy(scope, input) {
      assertScope(scope);
      const current = policyRow(scope);
      if (String(current.settings_revision) !== input.expectedSettingsRevision) fail("memory policy changed since it was loaded", "conflict");
      const patch = input.patch;
      if (patch.mode !== undefined && !["auto", "read-only", "off"].includes(patch.mode)) fail("memory mode is invalid");
      if (patch.reviewPolicy !== undefined && !["manual", "low-risk-auto-active"].includes(patch.reviewPolicy)) fail("review policy is invalid");
      if (patch.utilityStatus !== undefined && !["disabled", "ready", "unavailable", "blocked"].includes(patch.utilityStatus)) fail("utility status is invalid");
      if (patch.crossProjectRecall !== undefined && !crossProjectValues.has(patch.crossProjectRecall)) fail("cross-project recall is invalid");
      if (patch.utilityAllowlist !== undefined) {
        if (!Array.isArray(patch.utilityAllowlist) || patch.utilityAllowlist.length > MAX.array) fail("utility allowlist is invalid");
        for (const entry of patch.utilityAllowlist) {
          if (!entry || typeof entry.providerID !== "string" || typeof entry.modelID !== "string" || !entry.providerID.trim() || !entry.modelID.trim()) fail("utility allowlist entry is invalid");
        }
      }
      const budget = patch.contextBudget ?? { maxRecords: current.max_records, maxBytes: current.max_bytes, maxTokens: current.max_tokens ?? undefined };
      if (!Number.isSafeInteger(budget.maxRecords) || budget.maxRecords < 0 || budget.maxRecords > MAX_RECALL_RECORDS) fail("maxRecords must be between 0 and 8");
      if (!Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 0 || budget.maxBytes > MAX_RECALL_BYTES) fail("maxBytes must be between 0 and 6144");
      if (budget.maxTokens !== undefined && (!Number.isSafeInteger(budget.maxTokens) || budget.maxTokens < 0 || budget.maxTokens > 4096)) fail("maxTokens must be between 0 and 4096");
      const utilityBudget = patch.utilityBudget ?? { maxCalls: Number(current.utility_max_calls) };
      if (!Number.isSafeInteger(utilityBudget.maxCalls) || utilityBudget.maxCalls < 0 || utilityBudget.maxCalls > 10_000) fail("utility maxCalls must be between 0 and 10000");
      const configuredModel = patch.utilityModel === undefined
        ? (current.utility_model ? parse<MemoryPolicyDto["utilityModel"]>(current.utility_model, undefined) : undefined)
        : patch.utilityModel;
      const allowlist = patch.utilityAllowlist ?? parse<MemoryPolicyDto["utilityAllowlist"]>(current.utility_allowlist, []);
      const modelReady = Boolean(
        configuredModel?.providerID?.trim()
        && configuredModel.modelID?.trim()
        && allowlist.some((entry) => entry.providerID === configuredModel?.providerID && entry.modelID === configuredModel?.modelID),
      );
      const consentReady = (patch.utilityModelAllowed ?? (current.utility_model_allowed === 1))
        && !(patch.consentRequired ?? (current.consent_required === 1));
      const budgetReady = utilityBudget.maxCalls > 0;
      const readinessTouched = patch.utilityModel !== undefined
        || patch.utilityAllowlist !== undefined
        || patch.utilityModelAllowed !== undefined
        || patch.consentRequired !== undefined
        || patch.contextBudget !== undefined
        || patch.utilityBudget !== undefined;
      if (patch.utilityStatus === "ready" && !(modelReady && consentReady && budgetReady)) fail("utility readiness requires explicit consent, an allowlisted model, and a positive budget", "blocked");
      const utilityStatus = readinessTouched
        ? (modelReady && consentReady && budgetReady ? "ready" : ((patch.utilityModelAllowed ?? (current.utility_model_allowed === 1)) ? "blocked" : "disabled"))
        : (patch.utilityStatus ?? current.utility_status);
      const t = now();
      const generation = patch.mode === "off" && current.mode !== "off" ? randomUUID() : current.generation;
      return tx(db, () => {
        const result = db.prepare(`UPDATE memory_policy SET mode=?, generation=?, settings_revision=settings_revision+1,
          max_records=?, max_bytes=?, max_tokens=?, utility_model=?, utility_allowlist=?, utility_status=?, utility_max_calls=?, utility_model_allowed=?, consent_required=?, block_without_memory=?,
          review_policy=?, exclusions=?, cross_project=?, updated_at=? WHERE space_id=? AND project_id=? AND settings_revision=?`).run(
          patch.mode ?? current.mode, generation, budget.maxRecords, budget.maxBytes, budget.maxTokens ?? null,
          patch.utilityModel === undefined ? current.utility_model : (patch.utilityModel ? json(patch.utilityModel) : null),
          patch.utilityAllowlist === undefined ? current.utility_allowlist : json(patch.utilityAllowlist),
          utilityStatus,
          utilityBudget.maxCalls,
          patch.utilityModelAllowed === undefined ? current.utility_model_allowed : (patch.utilityModelAllowed ? 1 : 0),
          patch.consentRequired === undefined ? current.consent_required : (patch.consentRequired ? 1 : 0),
          patch.blockWithoutMemory === undefined ? current.block_without_memory : (patch.blockWithoutMemory ? 1 : 0),
          patch.reviewPolicy ?? current.review_policy,
          patch.exclusions ? json({ sessions: boundedStrings(patch.exclusions.sessions, "exclusions.sessions", 100, MAX.path), sources: boundedStrings(patch.exclusions.sources, "exclusions.sources", 100, MAX.path), paths: boundedStrings(patch.exclusions.paths, "exclusions.paths", 100, MAX.path) }) : current.exclusions,
          patch.crossProjectRecall ?? current.cross_project,
          t, scope.spaceId, scope.projectId, Number(input.expectedSettingsRevision),
        );
        if (Number(result.changes) !== 1) fail("memory policy changed since it was loaded", "conflict");
        if (patch.mode === "off") db.prepare("UPDATE memory_harvest_jobs SET status='stale', lease_owner=NULL, lease_expires_at=NULL WHERE space_id=? AND project_id=? AND status IN ('pending','leased')").run(scope.spaceId, scope.projectId);
        if (utilityStatus === "ready") db.prepare("UPDATE memory_harvest_jobs SET status='pending', next_attempt_at=?, error_code=NULL WHERE space_id=? AND project_id=? AND status='denied' AND error_code IN ('utility-unavailable','utility-budget-exhausted')").run(t, scope.spaceId, scope.projectId);
        return policyFrom(db.prepare("SELECT * FROM memory_policy WHERE space_id=? AND project_id=?").get(scope.spaceId, scope.projectId) as unknown as PolicyRow);
      });
    },
    list(scope, query = {}) {
      assertScope(scope);
      const policy = policyFrom(policyRow(scope));
      const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
      const offset = Math.max(0, query.offset ?? 0);
      const lifecycle = query.lifecycle;
      const q = query.q?.trim();
      const layers = layerClause(scope);
      const clauses = ["space_id = ?", layers.sql];
      const params: Array<string | number> = [scope.spaceId, ...layers.params];
      if (lifecycle) { clauses.push("lifecycle = ?"); params.push(lifecycle); }
      if (q) { clauses.push("(title LIKE ? OR body LIKE ? OR tags LIKE ? OR aliases LIKE ?)"); const needle = `%${q}%`; params.push(needle, needle, needle, needle); }
      const rows = db.prepare(`SELECT * FROM memory_records WHERE ${clauses.join(" AND ")} ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as unknown as MemoryRow[];
      const total = Number((db.prepare(`SELECT count(*) AS count FROM memory_records WHERE ${clauses.join(" AND ")}`).get(...params) as { count: number }).count);
      return { items: rows.map((row) => listItem(itemFrom(row))), total, policy };
    },
    search(scope, query) {
      assertScope(scope);
      const policy = policyFrom(policyRow(scope));
      const limit = Math.max(1, Math.min(Math.trunc(query.limit ?? 8) || 8, MAX_RECALL_RECORDS));
      // Delivery off means no agent may read memory, whatever the caller checked.
      if (policy.mode === "off") return { items: [], total: 0, policy };
      const matches = rankedActiveRows(scope, query.q.trim(), true).rows
        .map(itemFrom)
        .filter((item) => !excludedByPolicy(item, policy.exclusions));
      return { items: matches.slice(0, limit).map(listItem), total: matches.length, policy };
    },
    searchProjects(scope, query) {
      assertScope(scope);
      if (!Array.isArray(query.projectIds) || query.projectIds.length > MAX_SEARCH_PROJECTS) fail("project list is invalid");
      const limit = Math.max(1, Math.min(Math.trunc(query.limit ?? 8) || 8, MAX_RECALL_RECORDS));
      const requested = [...new Set(query.projectIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
      if (!requested.length) return { items: [], total: 0, searchedProjectIds: [] };
      // Read policies without creating rows: a project that never enabled
      // memory has no policy row and is off.
      const policies = new Map<string, MemoryPolicyDto>();
      for (const row of db.prepare(`SELECT * FROM memory_policy WHERE space_id=? AND project_id IN (${requested.map(() => "?").join(",")})`).all(scope.spaceId, ...requested) as unknown as PolicyRow[]) {
        const policy = policyFrom(row);
        if (policy.mode !== "off") policies.set(row.project_id, policy);
      }
      const searched = requested.filter((id) => policies.has(id));
      if (!searched.length) return { items: [], total: 0, searchedProjectIds: [] };
      const where = { sql: `(m.layer='project' AND m.project_id IN (${searched.map(() => "?").join(",")}))`, params: searched };
      const matches = rankedRows(scope.spaceId, where, query.q.trim(), true).rows
        .map(itemFrom)
        .filter((item) => !excludedByPolicy(item, policies.get(item.projectId)!.exclusions));
      return { items: matches.slice(0, limit).map(listItem), total: matches.length, searchedProjectIds: searched };
    },
    get(scope, id) {
      assertScope(scope);
      const row = grantedRow(scope, id);
      return row ? itemFrom(row) : undefined;
    },
    create(scope, input, options = {}) {
      assertScope(scope);
      if (input.projectId !== scope.projectId) fail("project scope mismatch", "forbidden");
      const target = options.placement ?? { layer: "project" };
      if (!grantsOf(scope).some((grant) => grantKey(grant) === grantKey(target))) fail("memory layer is not granted", "forbidden");
      const placement = placementOf(scope, target);
      const authoredBy = authorOf(options.authoredBy);
      const approver = options.approver?.userId;
      if (approver !== undefined && (typeof approver !== "string" || !approver.trim() || approver.length > 128)) fail("approver is invalid");
      const duplicate = ensureIdempotency(scope, input.idempotencyKey, input.requestFingerprint);
      if (duplicate) return duplicate;
      const normalized = normalizeInput(input);
      if (normalized.lifecycle !== "candidate" && normalized.lifecycle !== "active") fail("new memory lifecycle is invalid");
      const existing = db.prepare("SELECT * FROM memory_records WHERE space_id=? AND project_id=? AND layer=? AND owner_id=? AND title=? AND body=? AND category=? AND lifecycle != 'forgotten'").get(scope.spaceId, placement.projectId, placement.layer, placement.ownerId, normalized.title, normalized.body, normalized.category) as MemoryRow | undefined;
      return tx(db, () => {
        const policy = policyRow(scope);
        if (existing) {
          const receipt: MemoryReceiptDto = { operationId: input.idempotencyKey ?? randomUUID(), status: "duplicate", memoryId: existing.id, revision: existing.revision, generation: policy.generation, digest: digest(existing.body) };
          saveIdempotency(scope, input.idempotencyKey, input.requestFingerprint, receipt); return receipt;
        }
        const id = randomUUID(); const t = now();
        const item: MemoryRecordDto = {
          id, projectId: placement.projectId, ...normalized, revision: 1, createdAt: t, updatedAt: t,
          layer: placement.layer, ...(placement.ownerId ? { ownerId: placement.ownerId } : {}), ...(authoredBy ? { authoredBy } : {}),
          ...(approver && normalized.lifecycle === "active" ? { approvedBy: { userId: approver.trim(), at: t } } : {}),
        };
        insertRecord(scope.spaceId, item, placement, authoredBy);
        updateFts(item, scope.spaceId); revision(item, t); const dataRevision = bump(scope);
        const receipt: MemoryReceiptDto = { operationId: input.idempotencyKey ?? randomUUID(), status: "committed", memoryId: id, revision: 1, generation: policy.generation, digest: digest(json(item)) };
        saveIdempotency(scope, input.idempotencyKey, input.requestFingerprint, receipt); void dataRevision; return receipt;
      });
    },
    update(scope, input, actor = "user") {
      return updateRecord(scope, input, actor);
    },
    review(scope, id, expectedRevision, lifecycle, approver) {
      const approvedBy = approver && lifecycle === "active" ? { userId: approver.userId, at: now() } : undefined;
      if (approvedBy && (typeof approvedBy.userId !== "string" || !approvedBy.userId.trim() || approvedBy.userId.length > 128)) fail("approver is invalid");
      return updateRecord(scope, { id, projectId: scope.projectId, expectedRevision, patch: { lifecycle } } as MemoryPatchInput, "user", approvedBy);
    },
    restore(scope, id, expectedRevision, sourceRevision) {
      assertScope(scope);
      const row = grantedRow(scope, id);
      if (!row) fail("memory record not found", "not-found");
      const loaded = row as MemoryRow;
      if (Number(loaded.revision) !== expectedRevision) fail("memory record changed since it was loaded", "conflict");
      const source = db.prepare("SELECT payload FROM memory_revisions WHERE record_id=? AND project_id=? AND revision=?").get(id, loaded.project_id, sourceRevision) as unknown as { payload: string } | undefined;
      if (!source) fail("memory revision not found", "not-found");
      const sourceRow = source as { payload: string };
      const restored = parse<MemoryRecordDto | undefined>(sourceRow.payload, undefined);
      if (!restored || restored.id !== id) fail("memory revision is invalid", "invalid-data");
      const restoredItem = restored as MemoryRecordDto;
      return tx(db, () => {
        const t = now();
        // A revision restores content only; the record never changes layer,
        // owner or provenance.
        const current = itemFrom(loaded);
        const { layer: _layer, ownerId: _ownerId, authoredBy: _authoredBy, approvedBy: _approvedBy, ...content } = restoredItem;
        const next: MemoryRecordDto = { ...content, projectId: current.projectId, revision: expectedRevision + 1, updatedAt: t, userLocked: true,
          layer: current.layer ?? "project", ...(current.ownerId ? { ownerId: current.ownerId } : {}), ...(current.authoredBy ? { authoredBy: current.authoredBy } : {}), ...(current.approvedBy ? { approvedBy: current.approvedBy } : {}) };
        const result = db.prepare(`UPDATE memory_records SET title=?,body=?,category=?,tags=?,aliases=?,applicability=?,sources=?,lifecycle=?,evidence=?,freshness=?,pinned=?,user_locked=?,revision=?,updated_at=? WHERE id=? AND project_id=? AND space_id=? AND revision=?`).run(
          next.title, next.body, next.category, json(next.tags), json(next.aliases), json(next.applicability), json(next.sources), next.lifecycle, next.evidence, next.freshness, next.pinned ? 1 : 0, 1, next.revision, t, id, current.projectId, scope.spaceId, expectedRevision,
        );
        if (Number(result.changes) !== 1) fail("memory record changed since it was loaded", "conflict");
        updateFts(next, scope.spaceId); revision(next, t); const policy = policyRow(scope); bump(scope);
        return { operationId: randomUUID(), status: "committed", memoryId: id, revision: next.revision, generation: policy.generation, digest: digest(json(next)) };
      });
    },
    forget(scope, input) {
      assertScope(scope); const row = grantedRow(scope, input.id);
      if (!row) fail("memory record not found", "not-found");
      const loaded = row as MemoryRow;
      if (loaded.revision !== input.expectedRevision) fail("memory record changed since it was loaded", "conflict");
      return tx(db, () => {
        const policy = policyRow(scope); const t = now(); const generation = randomUUID();
        const result = db.prepare("UPDATE memory_records SET lifecycle='forgotten', revision=revision+1, updated_at=? WHERE id=? AND project_id=? AND space_id=? AND revision=?").run(t, input.id, loaded.project_id, scope.spaceId, input.expectedRevision);
        if (Number(result.changes) !== 1) fail("memory record changed since it was loaded", "conflict");
        for (const key of input.sourceKeys ?? sourceKeys(parse<MemorySourceRef[]>(loaded.sources, []))) db.prepare("INSERT OR REPLACE INTO memory_tombstones(space_id,project_id,source_key,generation,reason,created_at) VALUES(?,?,?,?,?,?)").run(scope.spaceId, scope.projectId, key, generation, "forgotten", t);
        db.prepare("UPDATE memory_policy SET generation=?, settings_revision=settings_revision+1, updated_at=? WHERE space_id=? AND project_id=? AND generation=?").run(generation, t, scope.spaceId, scope.projectId, policy.generation);
        db.prepare("UPDATE memory_harvest_jobs SET status='stale', lease_owner=NULL, lease_expires_at=NULL WHERE space_id=? AND project_id=? AND status IN ('pending','leased')").run(scope.spaceId, scope.projectId);
        bump(scope); return { operationId: randomUUID(), status: "committed", memoryId: input.id, revision: input.expectedRevision + 1, generation };
      });
    },
    clear(scope, expectedGeneration) {
      assertScope(scope);
      return tx(db, () => {
        const policy = policyRow(scope); if (policy.generation !== expectedGeneration) fail("memory generation changed", "conflict");
        const generation = randomUUID(); const t = now();
        // Clear resets the project's own memory; Space, agent and personal
        // records are not the project's to erase.
        const rows = db.prepare("SELECT * FROM memory_records WHERE space_id=? AND project_id=? AND layer='project' AND lifecycle != 'forgotten'").all(scope.spaceId, scope.projectId) as unknown as MemoryRow[];
        for (const row of rows) {
          const current = itemFrom(row);
          const next: MemoryRecordDto = { ...current, lifecycle: "forgotten", revision: current.revision + 1, updatedAt: t };
          db.prepare("UPDATE memory_records SET lifecycle='forgotten', revision=?, updated_at=? WHERE id=? AND space_id=? AND project_id=? AND revision=?").run(next.revision, t, next.id, scope.spaceId, scope.projectId, current.revision);
          revision(next, t); updateFts(next, scope.spaceId);
        }
        db.prepare("INSERT OR REPLACE INTO memory_tombstones(space_id,project_id,source_key,generation,reason,created_at) VALUES(?,?,?,?,?,?)").run(scope.spaceId, scope.projectId, "project-clear", generation, "clear", t);
        db.prepare("UPDATE memory_policy SET generation=?, settings_revision=settings_revision+1, harvesting='paused', updated_at=? WHERE space_id=? AND project_id=? AND generation=?").run(generation, t, scope.spaceId, scope.projectId, expectedGeneration);
        db.prepare("UPDATE memory_harvest_jobs SET status='stale', lease_owner=NULL, lease_expires_at=NULL WHERE space_id=? AND project_id=? AND status IN ('pending','leased')").run(scope.spaceId, scope.projectId);
        bump(scope); return { operationId: randomUUID(), status: "committed", generation };
      });
    },
    recall(scope, input) {
      assertScope(scope); const policy = policyFrom(policyRow(scope));
      const empty = (status: MemoryContribution["status"], reasons: string[]): MemoryContribution => ({ status, selected: [], omittedCount: 0, estimate: { bytes: 0, estimated: true }, dataRevision: String((db.prepare("SELECT data_revision FROM memory_meta WHERE space_id=?").get(scope.spaceId) as { data_revision?: number } | undefined)?.data_revision ?? 0), settingsRevision: policy.settingsRevision, generation: policy.generation, digest: digest(`${status}:${policy.generation}`), reasons });
      if (policy.mode === "off") return empty("blocked", ["memory-off"]);
      const maxRecords = Math.max(0, Math.min(input.maxRecords ?? policy.contextBudget.maxRecords, MAX_RECALL_RECORDS));
      const maxBytes = Math.max(0, Math.min(input.maxBytes ?? policy.contextBudget.maxBytes, MAX_RECALL_BYTES));
      if (!maxRecords || !maxBytes) return empty("empty", ["budget-zero"]);
      const queryText = [input.intent, ...(input.modules ?? []), ...(input.paths ?? []), input.error ?? "", ...(input.workingContext ?? [])].filter(Boolean).join(" ");
      const ranked = rankedActiveRows(scope, queryText);
      const degraded = ranked.degraded;
      let rows = ranked.rows;
      if (!queryText) {
        const layers = layerClause(scope);
        rows = db.prepare(`SELECT * FROM memory_records WHERE space_id=? AND ${layers.sql} AND lifecycle='active' AND pinned=1 ORDER BY updated_at DESC LIMIT 64`).all(scope.spaceId, ...layers.params) as unknown as MemoryRow[];
      }
      const exclusions = policy.exclusions;
      const selected: MemoryContribution["selected"] = [];
      for (const row of rows) {
        const item = itemFrom(row);
        if (excludedByPolicy(item, exclusions)) continue;
        if (selected.length >= maxRecords) break;
        const evidence = `${item.title}\n${item.body}`;
        const reason = item.pinned ? "pinned" : (degraded ? "bounded-lexical-fallback" : "fts");
        const full = { memoryId: item.id, revision: item.revision, digest: digest(json(item)), reason, text: evidence };
        if (bytes(memoryEnvelope([...selected, full])) <= maxBytes) {
          selected.push(full);
          continue;
        }
        const marker = `\n[truncated; id=${item.id}]`;
        const empty = { ...full, text: marker };
        const room = maxBytes - bytes(memoryEnvelope([...selected, empty]));
        const clipped = boundedEvidence(evidence, room);
        if (!clipped) continue;
        const bounded = { ...full, text: `${clipped}${marker}`, truncated: true };
        if (bytes(memoryEnvelope([...selected, bounded])) <= maxBytes) selected.push(bounded);
      }
      const modelVisibleText = selected.length ? memoryEnvelope(selected) : undefined;
      const status = selected.length ? (degraded ? "degraded" : "selected") : (degraded ? "degraded" : "empty");
      return { status, ...(modelVisibleText ? { modelVisibleText } : {}), selected, omittedCount: Math.max(0, rows.length - selected.length), estimate: { bytes: bytes(modelVisibleText ?? ""), estimated: true }, dataRevision: String((db.prepare("SELECT data_revision FROM memory_meta WHERE space_id=?").get(scope.spaceId) as { data_revision?: number } | undefined)?.data_revision ?? 0), settingsRevision: policy.settingsRevision, generation: policy.generation, digest: digest(modelVisibleText ?? `${status}:${policy.generation}`), reasons: [degraded ? "fts-unavailable" : "fts"] };
    },
    enqueueHarvest(scope, input) {
      assertScope(scope); if (input.spaceId !== scope.spaceId || input.projectId !== scope.projectId) fail("harvest scope mismatch", "forbidden");
      if (!input.jobKey || !Number.isSafeInteger(input.sourceStartSeq) || !Number.isSafeInteger(input.sourceEndSeq) || input.sourceEndSeq < input.sourceStartSeq) fail("harvest source range is invalid");
      const policy = policyRow(scope); const t = now();
      tx(db, () => db.prepare(`INSERT OR IGNORE INTO memory_harvest_jobs(job_key,space_id,project_id,session_id,source_start_seq,source_end_seq,source_digest,policy_generation,extractor_version,status,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?)`).run(input.jobKey, scope.spaceId, scope.projectId, input.sessionId, input.sourceStartSeq, input.sourceEndSeq, input.sourceDigest, input.policyGeneration || policy.generation, input.extractorVersion, input.nextAttemptAt ?? t));
      return apiJob(db.prepare("SELECT * FROM memory_harvest_jobs WHERE job_key=?").get(input.jobKey) as unknown as JobRow);
    },
    harvestCursor(scope, sessionId) {
      assertScope(scope);
      if (!sessionId.trim()) fail("harvest session is required");
      const row = db.prepare("SELECT session_id, next_seq, policy_generation, checkpoint_digest FROM memory_harvest_cursors WHERE space_id=? AND project_id=? AND session_id=?").get(scope.spaceId, scope.projectId, sessionId) as { session_id: string; next_seq: number; policy_generation: string; checkpoint_digest: string | null } | undefined;
      if (!row) return undefined;
      return { sessionId: row.session_id, nextSeq: Number(row.next_seq), policyGeneration: row.policy_generation, ...(row.checkpoint_digest ? { checkpointDigest: row.checkpoint_digest } : {}) };
    },
    resetHarvestCursor(scope, sessionId, policyGeneration, nextSeq) {
      assertScope(scope);
      if (!sessionId.trim() || !policyGeneration.trim() || !Number.isSafeInteger(nextSeq) || nextSeq < 1) fail("harvest cursor is invalid");
      tx(db, () => db.prepare(`INSERT INTO memory_harvest_cursors(space_id,project_id,session_id,next_seq,policy_generation,checkpoint_digest,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(space_id,project_id,session_id) DO UPDATE SET next_seq=excluded.next_seq, policy_generation=excluded.policy_generation, checkpoint_digest=excluded.checkpoint_digest, updated_at=excluded.updated_at`).run(scope.spaceId, scope.projectId, sessionId, nextSeq, policyGeneration, null, now()));
      return { sessionId, nextSeq, policyGeneration };
    },
    claimHarvest(scope, owner, leaseMs = 30_000, at = now()) {
      assertScope(scope); if (!owner.trim()) fail("harvest lease owner is required");
      return tx(db, () => {
        db.prepare("UPDATE memory_harvest_jobs SET status='failed', error_code='attempt-limit', lease_owner=NULL, lease_expires_at=NULL WHERE space_id=? AND project_id=? AND status='pending' AND attempts>=3").run(scope.spaceId, scope.projectId);
        const row = db.prepare(`SELECT * FROM memory_harvest_jobs WHERE space_id=? AND project_id=? AND status IN ('pending','leased') AND (status='pending' OR (status='leased' AND lease_expires_at <= ?)) AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY source_end_seq LIMIT 1`).get(scope.spaceId, scope.projectId, at, at) as JobRow | undefined;
        if (!row) return undefined;
        const updated = db.prepare("UPDATE memory_harvest_jobs SET status='leased', lease_owner=?, lease_expires_at=?, attempts=attempts+1 WHERE job_key=? AND (lease_owner IS NULL OR lease_expires_at <= ?)").run(owner, at + leaseMs, row.job_key, at);
        if (Number(updated.changes) !== 1) return undefined;
        return apiJob(db.prepare("SELECT * FROM memory_harvest_jobs WHERE job_key=?").get(row.job_key) as unknown as JobRow);
      });
    },
    commitHarvest(scope, jobKey, owner, policyGeneration, records, receiptId, checkpointDigest, nextSeq) {
      assertScope(scope);
      if (!jobKey.trim() || !owner.trim() || !policyGeneration.trim() || !receiptId.trim() || !checkpointDigest.trim() || !Number.isSafeInteger(nextSeq) || nextSeq < 1) fail("harvest commit is invalid");
      const normalized = records.map((record) => ({ ...normalizeInput({ ...record, projectId: scope.projectId }), idempotencyKey: record.idempotencyKey, requestFingerprint: record.requestFingerprint }));
      return tx(db, () => {
        const policy = policyRow(scope);
        if (policy.generation !== policyGeneration) fail("harvest generation changed", "stale-generation");
        const job = db.prepare("SELECT session_id, source_end_seq FROM memory_harvest_jobs WHERE job_key=? AND space_id=? AND project_id=? AND status='leased' AND lease_owner=? AND policy_generation=?").get(jobKey, scope.spaceId, scope.projectId, owner, policyGeneration) as { session_id: string; source_end_seq: number } | undefined;
        if (!job) fail("harvest lease is no longer active", "stale-lease");
        let committed = 0; let duplicates = 0; const t = now();
        for (const item of normalized) {
          const idem = db.prepare("SELECT fingerprint, receipt FROM memory_idempotency WHERE project_id=? AND operation_key=?").get(scope.projectId, item.idempotencyKey) as { fingerprint: string; receipt: string } | undefined;
          if (idem) {
            if (idem.fingerprint !== item.requestFingerprint) fail("idempotency key is already bound to another payload", "conflict");
            duplicates++; continue;
          }
          const existing = db.prepare("SELECT id FROM memory_records WHERE space_id=? AND project_id=? AND layer='project' AND title=? AND body=? AND category=? AND lifecycle != 'forgotten'").get(scope.spaceId, scope.projectId, item.title, item.body, item.category) as { id: string } | undefined;
          const operationId = `${jobKey}:${item.idempotencyKey}`;
          if (existing) {
            const receipt: MemoryReceiptDto = { operationId, status: "duplicate", memoryId: existing.id, generation: policy.generation };
            db.prepare("INSERT INTO memory_idempotency(project_id,operation_key,fingerprint,receipt,created_at) VALUES(?,?,?,?,?)").run(scope.projectId, item.idempotencyKey, item.requestFingerprint, json(receipt), t);
            duplicates++; continue;
          }
          const id = randomUUID();
          const { idempotencyKey: _idempotencyKey, requestFingerprint: _requestFingerprint, ...normalizedItem } = item;
          const authoredBy: MemoryAuthor = { kind: "system", via: "harvest" };
          const record: MemoryRecordDto = { id, projectId: scope.projectId, ...normalizedItem, userLocked: false, revision: 1, createdAt: t, updatedAt: t, layer: "project", authoredBy };
          insertRecord(scope.spaceId, record, { layer: "project", ownerId: "" }, authoredBy);
          updateFts(record, scope.spaceId); revision(record, t);
          const receipt: MemoryReceiptDto = { operationId, status: "committed", memoryId: id, revision: 1, generation: policy.generation, digest: digest(json(record)) };
          db.prepare("INSERT INTO memory_idempotency(project_id,operation_key,fingerprint,receipt,created_at) VALUES(?,?,?,?,?)").run(scope.projectId, item.idempotencyKey, item.requestFingerprint, json(receipt), t);
          committed++;
        }
        db.prepare("UPDATE memory_harvest_jobs SET status='processed', lease_owner=NULL, lease_expires_at=NULL, receipt_id=?, checkpoint_digest=?, error_code=NULL WHERE job_key=? AND space_id=? AND project_id=? AND status='leased' AND lease_owner=? AND policy_generation=?").run(receiptId, checkpointDigest, jobKey, scope.spaceId, scope.projectId, owner, policyGeneration);
        db.prepare(`INSERT INTO memory_harvest_cursors(space_id,project_id,session_id,next_seq,policy_generation,checkpoint_digest,updated_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(space_id,project_id,session_id) DO UPDATE SET next_seq=MAX(next_seq, excluded.next_seq), policy_generation=excluded.policy_generation, checkpoint_digest=excluded.checkpoint_digest, updated_at=excluded.updated_at`).run(scope.spaceId, scope.projectId, job!.session_id, nextSeq, policyGeneration, checkpointDigest, t);
        if (committed) bump(scope);
        return { committed, duplicates };
      });
    },
    skipHarvest(scope, jobKey, owner, policyGeneration, checkpointDigest, nextSeq) {
      assertScope(scope);
      if (!jobKey.trim() || !owner.trim() || !policyGeneration.trim() || !checkpointDigest.trim() || !Number.isSafeInteger(nextSeq) || nextSeq < 1) fail("harvest skip is invalid");
      return tx(db, () => {
        const policy = policyRow(scope);
        if (policy.generation !== policyGeneration) fail("harvest generation changed", "stale-generation");
        const job = db.prepare("SELECT session_id FROM memory_harvest_jobs WHERE job_key=? AND space_id=? AND project_id=? AND status='leased' AND lease_owner=? AND policy_generation=?").get(jobKey, scope.spaceId, scope.projectId, owner, policyGeneration) as { session_id: string } | undefined;
        if (!job) fail("harvest lease is no longer active", "stale-lease");
        const t = now();
        db.prepare("UPDATE memory_harvest_jobs SET status='skipped', lease_owner=NULL, lease_expires_at=NULL, receipt_id=NULL, checkpoint_digest=?, error_code='remember-off' WHERE job_key=? AND space_id=? AND project_id=? AND status='leased' AND lease_owner=? AND policy_generation=?").run(checkpointDigest, jobKey, scope.spaceId, scope.projectId, owner, policyGeneration);
        db.prepare(`INSERT INTO memory_harvest_cursors(space_id,project_id,session_id,next_seq,policy_generation,checkpoint_digest,updated_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(space_id,project_id,session_id) DO UPDATE SET next_seq=MAX(next_seq, excluded.next_seq), policy_generation=excluded.policy_generation, checkpoint_digest=excluded.checkpoint_digest, updated_at=excluded.updated_at`).run(scope.spaceId, scope.projectId, job!.session_id, nextSeq, policyGeneration, checkpointDigest, t);
        return true;
      });
    },
    reserveUtilityCall(scope, maxOutputTokens) {
      assertScope(scope);
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0 || maxOutputTokens > 4_096) fail("utility output budget is invalid");
      return tx(db, () => {
        const policy = policyRow(scope);
        if (Number(policy.utility_max_calls) <= Number(policy.utility_used_calls) + Number(policy.utility_reserved_calls)) fail("utility call budget exhausted", "utility-budget-exhausted");
        const reservationId = randomUUID(); const t = now();
        const result = db.prepare("UPDATE memory_policy SET utility_reserved_calls=utility_reserved_calls+1, updated_at=? WHERE space_id=? AND project_id=? AND utility_max_calls > utility_used_calls + utility_reserved_calls").run(t, scope.spaceId, scope.projectId);
        if (Number(result.changes) !== 1) fail("utility call budget exhausted", "utility-budget-exhausted");
        db.prepare("INSERT INTO memory_utility_reservations(reservation_id,space_id,project_id,generation,max_output_tokens,state,created_at,updated_at) VALUES(?,?,?,?,?,'reserved',?,?)").run(reservationId, scope.spaceId, scope.projectId, policy.generation, maxOutputTokens, t, t);
        return { reservationId, generation: policy.generation, maxOutputTokens };
      });
    },
    reconcileUtilityCall(scope, reservationId, outcome) {
      assertScope(scope);
      if (!reservationId.trim() || !["consumed", "released"].includes(outcome)) fail("utility reservation is invalid");
      tx(db, () => {
        const row = db.prepare("SELECT state FROM memory_utility_reservations WHERE reservation_id=? AND space_id=? AND project_id=?").get(reservationId, scope.spaceId, scope.projectId) as { state: string } | undefined;
        if (!row) fail("utility reservation not found", "not-found");
        if (row!.state !== "reserved") return;
        const t = now();
        const consumed = outcome === "consumed";
        const result = db.prepare("UPDATE memory_policy SET utility_reserved_calls=MAX(0, utility_reserved_calls-1), utility_used_calls=utility_used_calls+?, updated_at=? WHERE space_id=? AND project_id=?").run(consumed ? 1 : 0, t, scope.spaceId, scope.projectId);
        if (Number(result.changes) !== 1) fail("utility policy is unavailable", "unavailable");
        db.prepare("UPDATE memory_utility_reservations SET state=?, updated_at=? WHERE reservation_id=? AND state='reserved'").run(outcome, t, reservationId);
      });
    },
    completeHarvest(scope, jobKey, owner, receiptId, checkpointDigest) {
      assertScope(scope); const policy = policyRow(scope);
      return tx(db, () => Number(db.prepare("UPDATE memory_harvest_jobs SET status='processed', lease_owner=NULL, lease_expires_at=NULL, receipt_id=?, checkpoint_digest=?, error_code=NULL WHERE job_key=? AND space_id=? AND project_id=? AND status='leased' AND lease_owner=? AND policy_generation=?").run(receiptId, checkpointDigest, jobKey, scope.spaceId, scope.projectId, owner, policy.generation).changes) === 1);
    },
    failHarvest(scope, jobKey, owner, errorCode, retryAt = now() + 5_000, terminalStatus = "pending") {
      assertScope(scope); return tx(db, () => Number(db.prepare("UPDATE memory_harvest_jobs SET status=?, lease_owner=NULL, lease_expires_at=NULL, next_attempt_at=?, error_code=? WHERE job_key=? AND space_id=? AND project_id=? AND status='leased' AND lease_owner=?").run(terminalStatus, terminalStatus === "pending" ? retryAt : null, errorCode.slice(0, 120), jobKey, scope.spaceId, scope.projectId, owner).changes) === 1);
    },
    exportProject(scope, options = {}) {
      assertScope(scope); const lifecycle = options.includeArchived ? "lifecycle != 'forgotten'" : (options.includeCandidates ? "lifecycle IN ('active','candidate')" : "lifecycle='active'");
      // The recovery export covers the project's own memory, as clear does.
      const rows = db.prepare(`SELECT * FROM memory_records WHERE space_id=? AND project_id=? AND layer='project' AND ${lifecycle} ORDER BY updated_at`).all(scope.spaceId, scope.projectId) as unknown as MemoryRow[];
      return { format: "memory-json-v1", projectId: scope.projectId, generation: policyRow(scope).generation, exportedAt: now(), records: rows.map(itemFrom) };
    },
    importPreview(scope, input) {
      assertScope(scope); if (input.projectId !== scope.projectId || input.format !== "memory-json-v1" || !Array.isArray(input.records) || input.records.length > 1_000) fail("invalid memory import");
      let duplicates = 0; let conflicts = 0; let invalid = 0;
      for (const record of input.records) {
        try { normalizeInput({ ...record, projectId: scope.projectId }); } catch { invalid++; continue; }
        const row = db.prepare("SELECT body, title, category FROM memory_records WHERE space_id=? AND project_id=? AND layer='project' AND id=?").get(scope.spaceId, scope.projectId, record.id) as { body: string; title: string; category: string } | undefined;
        if (!row) continue; if (row.body === record.body && row.title === record.title && row.category === record.category) duplicates++; else conflicts++;
      }
      return { duplicates, conflicts, invalid };
    },
    importRecords(scope, input, mode = "merge") {
      assertScope(scope);
      if (mode !== "merge" && mode !== "replace") fail("invalid memory import mode");
      const preview = api.importPreview(scope, input);
      if (preview.invalid) fail("memory import contains invalid records");
      return tx(db, () => {
        const t = now(); const policy = policyRow(scope); let imported = 0;
        for (const record of input.records) {
          const normalized = normalizeInput({ ...record, projectId: scope.projectId });
          const existing = db.prepare("SELECT * FROM memory_records WHERE id=? AND space_id=? AND project_id=? AND layer='project'").get(record.id, scope.spaceId, scope.projectId) as MemoryRow | undefined;
          if (existing && mode === "merge") continue;
          // An id held by a record outside this project's layer is never
          // overwritten or shadowed by an import.
          if (!existing && db.prepare("SELECT 1 FROM memory_records WHERE id=?").get(record.id)) fail("memory import id is already in use", "conflict");
          if (existing) {
            const nextRevision = Number(existing.revision) + 1;
            db.prepare(`UPDATE memory_records SET title=?,body=?,category=?,tags=?,aliases=?,applicability=?,sources=?,lifecycle=?,evidence=?,freshness=?,pinned=?,user_locked=1,revision=?,updated_at=? WHERE id=? AND space_id=? AND project_id=?`).run(
              normalized.title, normalized.body, normalized.category, json(normalized.tags), json(normalized.aliases), json(normalized.applicability), json(normalized.sources), normalized.lifecycle, normalized.evidence, normalized.freshness, normalized.pinned ? 1 : 0, nextRevision, t, record.id, scope.spaceId, scope.projectId,
            );
            const next: MemoryRecordDto = { ...itemFrom(existing), ...normalized, id: record.id, projectId: scope.projectId, revision: nextRevision, createdAt: Number(existing.created_at), updatedAt: t, userLocked: true };
            updateFts(next, scope.spaceId); revision(next, t); imported++; continue;
          }
          const authoredBy: MemoryAuthor = { kind: "system", via: "import" };
          const next: MemoryRecordDto = { ...normalized, id: record.id, projectId: scope.projectId, revision: 1, createdAt: t, updatedAt: t, userLocked: true, layer: "project", authoredBy };
          insertRecord(scope.spaceId, next, { layer: "project", ownerId: "" }, authoredBy);
          updateFts(next, scope.spaceId); revision(next, t); imported++;
        }
        if (imported) bump(scope);
        return { operationId: randomUUID(), status: "committed", generation: policy.generation, message: `imported ${imported} record(s)` };
      });
    },
    close() { if (!closed) { closed = true; } },
  };
  return api;
}

const apiJob = (row: JobRow): MemoryHarvestJobDto => ({
  jobKey: row.job_key, spaceId: row.space_id, projectId: row.project_id, sessionId: row.session_id,
  sourceStartSeq: Number(row.source_start_seq), sourceEndSeq: Number(row.source_end_seq), sourceDigest: row.source_digest,
  policyGeneration: row.policy_generation, extractorVersion: row.extractor_version, status: row.status as MemoryHarvestJobDto["status"],
  attempts: Number(row.attempts), ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: Number(row.lease_expires_at) }),
  ...(row.next_attempt_at === null ? {} : { nextAttemptAt: Number(row.next_attempt_at) }), ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
  ...(row.checkpoint_digest ? { checkpointDigest: row.checkpoint_digest } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}),
});
