import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";
import type {
  JsonObject,
  ModelRef,
  WorkflowDto,
  WorkflowDecisionInputDto,
  WorkflowEdgeDto,
  WorkflowLaunchOptionsDto,
  WorkflowNodeDto,
  WorkflowPermissionPolicy,
  WorkflowPipeMode,
  WorkflowPreferencesDto,
  WorkflowReviewFindingDto,
  WorkflowRunContextDto,
  WorkflowRunDto,
  WorkflowRunNodeDto,
  WorkflowRunOptionsDto,
  WorkflowRunStatus,
  SpaceContext,
} from "@polyth/contracts";
import type { AppendEventOptions } from "@polyth/plugins";
import type { JudgmentService } from "@polyth/judgment/server";
import { ancestors, layerize, upstream } from "./graph.ts";
import { buildNodePrompt, buildReworkPrompt, type WorkflowPromptSource } from "./prompt.ts";
import {
  DEFAULT_REVIEW_ROUNDS,
  MAX_REVIEW_ROUNDS,
  descendants,
  isExecutorNode,
  matchDispute,
  parseDisputes,
  parseReviewFindings,
  parseReviewVerdict,
  reworkTargets,
  verdictFromFindings,
} from "./review.ts";
import { resolveReviewVerdict, type JudgedVerdictOutcome } from "./judgment.ts";

export { ancestors, layerize, upstream, wouldCycle } from "./graph.ts";
export { buildNodePrompt, buildReworkPrompt, REVIEW_VERDICT_REQUIREMENT } from "./prompt.ts";
export {
  DEFAULT_REVIEW_ROUNDS,
  MAX_REVIEW_ROUNDS,
  isExecutorNode,
  isReviewNode,
  matchDispute,
  parseDisputes,
  parseReviewFindings,
  parseReviewVerdict,
  reworkTargets,
  verdictFromFindings,
} from "./review.ts";
export {
  DEFAULT_VERDICT_MARGIN,
  DEFAULT_VERDICT_THRESHOLD,
  DEFAULT_VERDICT_UNCERTAIN,
  WORKFLOW_REVIEW_VERDICT_SCOPE,
  WORKFLOW_REVIEW_VERDICT_USE_ID,
  boundReviewReportTail,
  createReviewVerdictQuestion,
  judgeReviewVerdict,
  resolveReviewVerdict,
  workflowReviewVerdictDescriptor,
  type JudgeReviewOptions,
  type JudgedVerdictOutcome,
  type WorkflowReviewChoice,
  type WorkflowReviewJudgmentDto,
  type WorkflowVerdictUncertainPolicy,
} from "./judgment.ts";
export type { LayerResult, WorkflowGraph } from "./graph.ts";
export type { WorkflowPromptSource, WorkflowReworkPrompt } from "./prompt.ts";

export interface WorkflowCreateInput {
  projectId: string;
  name: string;
  description?: string;
  category?: WorkflowDto["category"];
  profile?: WorkflowDto["profile"];
  preset?: WorkflowDto["preset"];
  nodes: WorkflowNodeDto[];
  edges: WorkflowEdgeDto[];
  defaults?: WorkflowRunOptionsDto;
}
export interface WorkflowUpdateInput
  extends Partial<Omit<WorkflowCreateInput, "projectId">> {
  expectedRevision?: number;
}
export type WorkflowNodeUpdate = Partial<
  Omit<WorkflowRunNodeDto, "id" | "role">
>;

export interface RunNodeContext {
  parentSessionId: string;
  runId: string;
  workflowId: string;
  projectId: string;
  node: WorkflowNodeDto;
  prompt: string;
  permissions: WorkflowPermissionPolicy;
  timeoutMs: number;
  signal: AbortSignal;
  attempt?: number;
  context?: WorkflowRunContextDto;
  /** Pass number; 2 or more when a review sent the work back. */
  round?: number;
  /** Continue this existing child session with a follow-up turn instead of
   * creating a new one. The runner falls back to a fresh child when the
   * session can no longer be reached. */
  resumeSessionId?: string;
  /** The person who started the run; absent for system work. */
  launchedBy?: string;
}
export type RunNodeFn = (
  context: RunNodeContext,
  onUpdate: (patch: WorkflowNodeUpdate) => Promise<void>
) => Promise<{ sessionId?: string; output: string }>;
export interface WorkflowDeps {
  file: string;
  append: (
    sessionId: string,
    type: string,
    data: JsonObject,
    options?: AppendEventOptions
  ) => Promise<unknown>;
  runNode: RunNodeFn;
  now?: () => number;
  buildContext?: (
    sessionId: string,
    launch?: WorkflowLaunchOptionsDto,
    input?: string,
    launchedBy?: string
  ) => Promise<WorkflowRunContextDto | undefined>;
  legacyFile?: string;
  ownsLegacyProject?: (projectId: string) => boolean;
  /** Canonical bundled definitions are resolved as an immutable overlay and
   * never copied into the tenant store merely to make them runnable. */
  builtin?: (id: string) => WorkflowDto | null;
  /** Called once a run is admitted. A parent created only to host the run has
   * no user turn of its own; its owner names it from the task. */
  onRunStarted?: (run: WorkflowRunDto, launchedBy?: string) => void;
  /** Runs that were still marked running when the last process stopped. They
   *  are fenced as stopped here, so their parent's background activity is
   *  stale and must be dropped instead of showing a phantom working chat. */
  onInterruptedRunsRecovered?: (runs: readonly WorkflowRunDto[]) => void;
  space?: SpaceContext;
  /** The context a run acts in, from the person who started it (undefined
   * for system work). Throws when that person can no longer act here. */
  spaceFor?: (launchedBy: string | undefined) => SpaceContext;
  judgment?: JudgmentService | (() => JudgmentService | undefined);
  /** How long a run holds a review gate for a person's decision before it
   * moves on (default 24 h). */
  decisionTimeoutMs?: number;
  /** The review loop reached an outcome worth telling the person: every
   * review approved, or a gate waits for their decision. Delivery only. */
  onReviewSettled?: (event: WorkflowReviewSettled) => void;
}
export interface WorkflowReviewSettled {
  runId: string;
  parentSessionId: string;
  outcome: "approved" | "needs-decision";
  /** The most passes any review took (1 is the first pass). */
  rounds: number;
}
/** A unit's route: what runs it. The only part of a template a run can change. */
export type WorkflowNodeRoute = Pick<WorkflowNodeDto, "model" | "harness" | "agent">;
export interface WorkflowRetryOptions {
  /** Keep the replacement route on the run's template for every later run. */
  saveToWorkflow?: boolean;
}
export interface WorkflowService {
  list(projectId?: string): WorkflowDto[];
  get(id: string): WorkflowDto | null;
  /** A bundled template with this project's saved routes applied. */
  withRoutes(workflow: WorkflowDto): WorkflowDto;
  create(input: WorkflowCreateInput): WorkflowDto;
  update(id: string, patch: WorkflowUpdateInput): WorkflowDto;
  remove(id: string): boolean;
  start(
    workflowId: string,
    sessionId: string,
    input: string,
    options?: WorkflowRunOptionsDto,
    launch?: WorkflowLaunchOptionsDto,
    /** The person starting the run; omit for system work. */
    launchedBy?: string
  ): Promise<WorkflowRunDto>;
  listRuns(projectId?: string): WorkflowRunDto[];
  getRun(runId: string): WorkflowRunDto | null;
  stop(runId: string): Promise<WorkflowRunDto>;
  /** A unit the running run holds for a fix continues in place; a settled
   * run forks from the unit. */
  retry(
    runId: string,
    nodeId: string,
    clientOperationId?: string,
    replacement?: WorkflowNodeRoute,
    /** Who asks for the retry. The fork acts for this person; system retries
     * (no person) keep the original launcher. */
    requestedBy?: string,
    options?: WorkflowRetryOptions
  ): Promise<WorkflowRunDto>;
  /** Settles a review gate the running run holds because its rounds are
   * spent and blockers remain. Only the person who started the run decides;
   * repeating a decision that already applied returns the run unchanged. */
  decide(
    runId: string,
    input: WorkflowDecisionInputDto,
    requestedBy?: string
  ): Promise<WorkflowRunDto>;
  getPreferences(projectId: string): WorkflowPreferencesDto;
  updatePreferences(
    projectId: string,
    patch: Partial<WorkflowPreferencesDto>
  ): WorkflowPreferencesDto;
}
interface ActiveRun {
  parentSessionId: string;
  workflow: WorkflowDto;
  run: WorkflowRunDto;
  controller: AbortController;
  done: Promise<void>;
  /** A terminal append was attempted but its admission outcome is unresolved. */
  terminalEventAttempted?: boolean;
  /** The canonical terminal event was accepted before local projection work failed. */
  terminalEventAccepted?: boolean;
}
interface State {
  v: 1;
  workflows: WorkflowDto[];
  runs?: WorkflowRunDto[];
  preferences?: Record<string, WorkflowPreferencesDto>;
  operations?: Record<
    string,
    { runId: string; workflowId: string; input: string; fingerprint?: string }
  >;
  /** runId -> userId of the person who started it. Kept beside the run so the
   * person is never sent to clients with run snapshots. */
  launchers?: Record<string, string>;
  /** Bundled template id -> node id -> the route this project saved for it.
   * The template itself stays canonical; only who runs each unit changes. */
  routes?: Record<string, Record<string, WorkflowNodeRoute>>;
}

interface PendingOperation {
  fingerprint: string;
  promise: Promise<WorkflowRunDto>;
}

const MAX_CONTEXT = 12_000;
const DEFAULT_MAX_PARALLEL = 4;
const DEFAULT_NODE_TIMEOUT_MS = 30 * 60_000;
/** A held review gate waits this long for a person, then the run moves on. */
const DEFAULT_DECISION_TIMEOUT_MS = 24 * 60 * 60_000;
/** A person may grant at most this many rounds beyond the limit per gate. */
const MAX_EXTRA_ROUNDS = 2;
const MAX_DECISION_NOTE = 2_000;
/** Node activity that asks a person to act (see `workflowHumanWait`). */
const HUMAN_WAIT = /^awaiting (?:permission|answer)(?::|$)/i;
const error = (message: string, code = "invalid-input") =>
  Object.assign(new Error(message), { code });
const clone = <T>(value: T): T => structuredClone(value);
const sameModel = (left?: ModelRef, right?: ModelRef): boolean =>
  !!left && !!right && left.providerID === right.providerID && left.modelID === right.modelID;
const isModel = (value: unknown): value is ModelRef => {
  if (!value || typeof value !== "object") return false;
  const model = value as { providerID?: unknown; modelID?: unknown; variant?: unknown };
  return (
    typeof model.providerID === "string" &&
    Boolean(model.providerID.trim()) &&
    model.providerID.length <= 300 &&
    typeof model.modelID === "string" &&
    Boolean(model.modelID.trim()) &&
    model.modelID.length <= 300 &&
    (model.variant === undefined || typeof model.variant === "string")
  );
};
const isHarness = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false;
  const harness = value as { mode?: unknown; harnessId?: unknown };
  return harness.mode === "auto" || (harness.mode === "pinned" && typeof harness.harnessId === "string"
    && Boolean(harness.harnessId.trim()) && harness.harnessId.length <= 300);
};
/** A replacement route from a request, or an invalid-input error. */
function routeOf(value: unknown): WorkflowNodeRoute {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw error("invalid replacement route");
  const raw = value as { model?: unknown; harness?: unknown; agent?: unknown };
  if (raw.model !== undefined && !isModel(raw.model)) throw error("invalid replacement model");
  if (raw.harness !== undefined && !isHarness(raw.harness)) throw error("invalid replacement harness");
  if (raw.agent !== undefined && (typeof raw.agent !== "string" || !raw.agent.trim() || raw.agent.length > 300))
    throw error("invalid replacement agent");
  const model = raw.model as ModelRef | undefined;
  return {
    ...(model ? { model: { providerID: model.providerID, modelID: model.modelID, ...(model.variant ? { variant: model.variant } : {}) } } : {}),
    ...(raw.harness ? { harness: clone(raw.harness as WorkflowNodeDto["harness"]) } : {}),
    ...(typeof raw.agent === "string" ? { agent: raw.agent } : {}),
  };
}
/** `node` run by `route`; a chosen model pins the unit (it leaves Auto). The
 * caller picks a model the chosen harness offers, as node retry always has. */
function routed(node: WorkflowNodeDto, route: WorkflowNodeRoute): WorkflowNodeDto {
  const next: WorkflowNodeDto = { ...node, ...clone(route) };
  if (route.model) delete next.allowedModels;
  return next;
}
const restore = <T extends object>(target: T, snapshot: T): void => {
  for (const key of Object.keys(target))
    if (!(key in snapshot)) delete (target as Record<string, unknown>)[key];
  Object.assign(target, snapshot);
};
const json = (value: unknown): JsonObject =>
  JSON.parse(JSON.stringify(value)) as JsonObject;
const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Model-visible summary of a settled run for its parent conversation. Child
 * session ids let the parent agent read a unit's complete report. */
export function workflowContextText(
  run: Pick<WorkflowRunDto, "input" | "nodes">,
  status: WorkflowRunStatus,
  result: string
): string {
  const lines = [
    `Status: ${status}`,
    "",
    "Request:",
    clip(run.input.trim(), 2_000),
    "",
    "Units:",
    ...run.nodes.map((node) => {
      const error = node.status === "error" && node.error?.trim()
        ? ` — ${clip(node.error.trim().replace(/\s+/g, " "), 300)}`
        : "";
      const judged = node.judgment ? ` (judged ${Math.round(node.judgment.topProbability * 100)}%)` : "";
      const verdict = node.verdict === "approved" ? ", approved"
        : node.verdict === "changes-requested" ? ", changes requested"
        : node.judgment?.verdict === "uncertain" ? ", uncertain verdict" : "";
      const round = (node.round ?? 1) > 1 ? ` (round ${node.round})` : "";
      const session = node.sessionId ? ` (session ${node.sessionId})` : "";
      return `- ${node.role}: ${node.status}${verdict}${judged}${round}${session}${error}`;
    }),
  ];
  const accepted = run.nodes.filter((node) => node.status === "done" && node.verdict === "changes-requested" && node.decision === "accepted");
  if (accepted.length)
    lines.push("", `Review outcome: ${accepted.map((node) => node.role).join(", ")} still requested changes after the allowed rework rounds; the person accepted the work as it is.`);
  const unresolved = run.nodes.filter((node) => node.status === "done" && node.verdict === "changes-requested" && node.decision !== "accepted");
  if (unresolved.length)
    lines.push("", `Review outcome: ${unresolved.map((node) => node.role).join(", ")} still requested changes after the allowed rework rounds; the result below is not approved.`);
  const uncertain = run.nodes.filter((node) => node.status === "done" && node.judgment?.verdict === "uncertain");
  if (uncertain.length)
    lines.push("", `Review outcome: ${uncertain.map((node) => node.role).join(", ")} produced an uncertain verdict requiring human attention.`);
  if (result.trim()) lines.push("", "Result:", result.trim());
  else if (status !== "done") lines.push("", "No final result was produced.");
  return lines.join("\n");
}

/** `workflow/node-progress` payload for the next node state. With a known
 *  previously published snapshot the event is `partial`: `node` holds the id,
 *  status and every changed field (`null` clears one), and output that only
 *  grew travels as `outputDelta`. Without a snapshot it is the full node. */
export function progressPayload(
  previous: WorkflowRunNodeDto | undefined,
  next: WorkflowRunNodeDto
): { node: Record<string, unknown>; partial?: true; outputDelta?: string } {
  if (!previous) return { node: { ...next } };
  const node: Record<string, unknown> = { id: next.id, status: next.status };
  let outputDelta: string | undefined;
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    const before = (previous as unknown as Record<string, unknown>)[key];
    const after = (next as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (after === undefined) {
      node[key] = null;
      continue;
    }
    if (key === "output" && typeof before === "string" && typeof after === "string"
      && after.length > before.length && after.startsWith(before)) {
      outputDelta = after.slice(before.length);
      continue;
    }
    node[key] = after;
  }
  return { node, partial: true, ...(outputDelta !== undefined ? { outputDelta } : {}) };
}

function validateOptions(options?: WorkflowRunOptionsDto): void {
  if (!options) return;
  if (
    options.pipe !== undefined &&
    options.pipe !== "direct" &&
    options.pipe !== "ancestors"
  )
    throw error("pipe must be direct or ancestors");
  if (
    options.permissions !== undefined &&
    options.permissions !== "auto" &&
    options.permissions !== "manual"
  )
    throw error("permissions must be auto or manual");
  if (
    options.maxParallel !== undefined &&
    (!Number.isInteger(options.maxParallel) ||
      options.maxParallel < 1 ||
      options.maxParallel > 32)
  )
    throw error("maxParallel must be a whole number from 1 to 32");
  if (
    options.nodeTimeoutMs !== undefined &&
    (!Number.isInteger(options.nodeTimeoutMs) || options.nodeTimeoutMs < 1_000)
  )
    throw error("nodeTimeoutMs must be a whole number >= 1000");
  if (
    options.reviewRounds !== undefined &&
    (!Number.isInteger(options.reviewRounds) ||
      options.reviewRounds < 0 ||
      options.reviewRounds > MAX_REVIEW_ROUNDS)
  )
    throw error(`reviewRounds must be a whole number from 0 to ${MAX_REVIEW_ROUNDS}`);
}
function validate(input: WorkflowCreateInput): string[][] {
  if (!input.projectId.trim()) throw error("projectId is required");
  if (!input.name.trim()) throw error("workflow name is required");
  for (const node of input.nodes) {
    if (!node.role.trim())
      throw error(`role is required for node ${node.id || "(missing id)"}`);
    if (!node.prompt.trim())
      throw error(`prompt is required for node ${node.id || "(missing id)"}`);
    if (node.harness?.mode === "pinned" && !node.harness.harnessId.trim())
      throw error("harnessId is required");
    if (node.allowedModels !== undefined) {
      if (
        !Array.isArray(node.allowedModels) ||
        node.allowedModels.length > 24 ||
        !node.allowedModels.every(isModel)
      )
        throw error(`allowedModels is invalid for node ${node.id || "(missing id)"}`);
    }
  }
  const result = layerize(input);
  if (!result.ok) throw error(result.error);
  validateOptions(input.defaults);
  return result.layers;
}
function options(
  defaults?: WorkflowRunOptionsDto,
  override?: WorkflowRunOptionsDto
): Required<WorkflowRunOptionsDto> {
  validateOptions(defaults);
  validateOptions(override);
  const merged = { ...defaults, ...override };
  return {
    pipe: (merged.pipe ?? "ancestors") as WorkflowPipeMode,
    permissions: (merged.permissions ?? "manual") as WorkflowPermissionPolicy,
    maxParallel: Math.max(
      1,
      Math.min(32, Math.floor(merged.maxParallel ?? DEFAULT_MAX_PARALLEL))
    ),
    nodeTimeoutMs: Math.max(
      1_000,
      Math.floor(merged.nodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS)
    ),
    reviewRounds: Math.max(
      0,
      Math.min(MAX_REVIEW_ROUNDS, Math.floor(merged.reviewRounds ?? DEFAULT_REVIEW_ROUNDS))
    ),
  };
}
function validateLaunch(launch?: WorkflowLaunchOptionsDto): void {
  if (!launch) return;
  if (
    launch.clientOperationId !== undefined &&
    (!launch.clientOperationId.trim() || launch.clientOperationId.length > 200)
  )
    throw error("clientOperationId must be a non-empty bounded string");
  if (
    launch.context !== undefined &&
    launch.context !== "recent" &&
    launch.context !== "request"
  )
    throw error("context must be recent or request");
  if (
    launch.sourceMessageSeq !== undefined &&
    (!Number.isSafeInteger(launch.sourceMessageSeq) ||
      launch.sourceMessageSeq < 0)
  )
    throw error("sourceMessageSeq must be a non-negative integer");
  const model = launch.model as unknown;
  if (model !== undefined) {
    const candidate = model as {
      providerID?: unknown;
      modelID?: unknown;
      variant?: unknown;
    };
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof candidate.providerID !== "string" ||
      !candidate.providerID.trim() ||
      candidate.providerID.length > 300 ||
      typeof candidate.modelID !== "string" ||
      !candidate.modelID.trim() ||
      candidate.modelID.length > 300 ||
      (candidate.variant !== undefined &&
        (typeof candidate.variant !== "string" || candidate.variant.length > 100))
    )
      throw error("invalid workflow launch model");
  }
  const harness = launch.harness as unknown;
  if (harness !== undefined) {
    const candidate = harness as { mode?: unknown; harnessId?: unknown };
    if (
      !candidate ||
      typeof candidate !== "object" ||
      (candidate.mode !== "auto" &&
        (candidate.mode !== "pinned" ||
          typeof candidate.harnessId !== "string" ||
          !candidate.harnessId.trim() ||
          candidate.harnessId.length > 300))
    )
      throw error("invalid workflow launch harness");
  }
  const agent = launch.agent as unknown;
  if (
    agent !== undefined &&
    (typeof agent !== "string" || !agent.trim() || agent.length > 300)
  )
    throw error("invalid workflow launch agent");
  if (launch.attachments !== undefined && !Array.isArray(launch.attachments))
    throw error("invalid workflow attachments");
  if ((launch.attachments?.length ?? 0) > 32)
    throw error("too many workflow attachments");
  for (const attachment of launch.attachments ?? [])
    if (
      !attachment ||
      typeof attachment.id !== "string" ||
      typeof attachment.name !== "string" ||
      typeof attachment.mime !== "string" ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size < 0
    )
      throw error("invalid workflow attachment");
}
function applyLaunchDefaults(
  workflow: WorkflowDto,
  launch?: WorkflowLaunchOptionsDto
): WorkflowDto {
  if (!launch && !workflow.nodes.some((node) => node.allowedModels !== undefined))
    return workflow;
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      if (node.allowedModels !== undefined) {
        // Auto route: inherit the launch model only when the node uses the
        // launch harness. A different pinned harness must choose its own
        // default when the allow-list is empty; forwarding the chat model
        // would silently send an incompatible model to that harness.
        const allowed = node.allowedModels;
        const launchModelCompatible = node.harness?.mode !== "pinned" ||
          (launch?.harness?.mode === "pinned" &&
            node.harness.harnessId === launch.harness.harnessId);
        // A saved node.model may coexist with Auto in legacy/API input; only
        // the launch route can supply Auto's preferred model.
        const preferred = launchModelCompatible ? launch?.model : undefined;
        const chosen = allowed.length === 0
          ? preferred
          : preferred && allowed.some((entry) => sameModel(entry, preferred))
            ? preferred
            : allowed[0];
        return {
          ...node,
          model: chosen ? clone(chosen) : undefined,
          ...(node.harness || !launch?.harness ? {} : { harness: clone(launch.harness) }),
          ...(node.agent || !launch?.agent ? {} : { agent: launch.agent }),
        };
      }
      // A node with any authored assignment keeps that complete route. Only
      // wholly unassigned nodes inherit the current Chat route.
      if (node.model || node.harness || node.agent) return node;
      return {
        ...node,
        ...(launch?.model ? { model: clone(launch.model) } : {}),
        ...(launch?.harness ? { harness: clone(launch.harness) } : {}),
        ...(launch?.agent ? { agent: launch.agent } : {}),
      };
    }),
  };
}

function read(file: string): Partial<State> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw error(`workflow store has an invalid shape: ${file}`, "storage-error");
    return parsed as Partial<State>;
  } catch (cause) {
    if ((cause as { code?: string }).code === "ENOENT") return undefined;
    throw error(`workflow store could not be read: ${file}`, "storage-error");
  }
}
function load(
  file: string,
  legacyFile?: string,
  owns?: (id: string) => boolean
): State {
  const current = read(file);
  const record = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const validNode = (value: unknown): boolean =>
    record(value) &&
    typeof value.id === "string" &&
    typeof value.role === "string" &&
    typeof value.prompt === "string";
  const validEdge = (value: unknown): boolean =>
    record(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    typeof value.target === "string";
  const validRunNode = (value: unknown): boolean =>
    record(value) &&
    typeof value.id === "string" &&
    typeof value.status === "string";
  const validWorkflow = (value: unknown): value is WorkflowDto =>
    record(value) &&
    typeof value.id === "string" &&
    typeof value.projectId === "string" &&
    typeof value.name === "string" &&
    Array.isArray(value.nodes) &&
    value.nodes.every(validNode) &&
    Array.isArray(value.edges) &&
    value.edges.every(validEdge);
  const validRun = (value: unknown): value is WorkflowRunDto =>
    record(value) &&
    typeof value.id === "string" &&
    typeof value.workflowId === "string" &&
    typeof value.status === "string" &&
    Array.isArray(value.nodes) &&
    value.nodes.every(validRunNode);
  const validOperation = (value: unknown): boolean =>
    record(value) &&
    typeof value.runId === "string" &&
    typeof value.workflowId === "string" &&
    typeof value.input === "string" &&
    (value.fingerprint === undefined || typeof value.fingerprint === "string");
  const validPreferences = (value: unknown): boolean =>
    record(value) &&
    Array.isArray(value.pinnedIds) &&
    value.pinnedIds.every((id) => typeof id === "string") &&
    Array.isArray(value.recentIds) &&
    value.recentIds.every((id) => typeof id === "string");
  const validLaunchers = (value: unknown): boolean =>
    record(value) && Object.values(value).every((id) => typeof id === "string" && id.length > 0);
  const validRoutes = (value: unknown): boolean =>
    record(value) && Object.values(value).every((nodes) => record(nodes) && Object.values(nodes).every(record));
  if (current) {
    if (
      (current.v !== undefined && current.v !== 1) ||
      !Array.isArray(current.workflows) ||
      !current.workflows.every(validWorkflow) ||
      (current.runs !== undefined && !Array.isArray(current.runs)) ||
      (Array.isArray(current.runs) && !current.runs.every(validRun)) ||
      (current.preferences !== undefined &&
        (!current.preferences || typeof current.preferences !== "object" ||
          Array.isArray(current.preferences) ||
          !Object.values(current.preferences).every(validPreferences))) ||
      (current.operations !== undefined &&
        (!current.operations || typeof current.operations !== "object" ||
          Array.isArray(current.operations) ||
          !Object.values(current.operations).every(validOperation))) ||
      (current.launchers !== undefined && !validLaunchers(current.launchers)) ||
      (current.routes !== undefined && !validRoutes(current.routes))
    )
      throw error(`workflow store has an invalid shape: ${file}`, "storage-error");
    return {
      v: 1,
      workflows: current.workflows as WorkflowDto[],
      runs: Array.isArray(current.runs)
        ? (current.runs as WorkflowRunDto[])
        : [],
      preferences: current.preferences as State["preferences"],
      operations: current.operations as State["operations"],
      launchers: current.launchers as State["launchers"],
      routes: current.routes as State["routes"],
    };
  }
  const legacy = legacyFile ? read(legacyFile) : undefined;
  if (
    legacy?.workflows !== undefined &&
    (!Array.isArray(legacy.workflows) || !legacy.workflows.every(validWorkflow))
  )
    throw error(`legacy workflow store has an invalid shape: ${legacyFile}`, "storage-error");
  return {
    v: 1,
    workflows: Array.isArray(legacy?.workflows)
      ? (legacy.workflows as WorkflowDto[]).filter(
          (w) => !owns || owns(w.projectId)
        )
      : [],
    runs: [],
    preferences: {},
    operations: {},
  };
}
function contextOf(
  value?: WorkflowRunContextDto
): WorkflowRunContextDto | undefined {
  if (!value) return undefined;
  return {
    ...(typeof value.conversation === "string"
      ? { conversation: value.conversation.slice(0, MAX_CONTEXT) }
      : {}),
    ...(value.attachments
      ? { attachments: clone(value.attachments).slice(0, 32) }
      : {}),
    ...(Number.isSafeInteger(value.sourceMessageSeq)
      ? { sourceMessageSeq: value.sourceMessageSeq }
      : {}),
  };
}

export function createWorkflowService(deps: WorkflowDeps): WorkflowService {
  const now = deps.now ?? Date.now;
  const state = load(deps.file, deps.legacyFile, deps.ownsLegacyProject);
  let workflows = state.workflows.filter((w) => w && typeof w.id === "string");
  const records = new Map<string, WorkflowRunDto>();
  const active = new Map<string, ActiveRun>();
  // A source run may have at most one retry fork. The lock is keyed by the
  // source run, rather than node, so two different client operation ids cannot
  // concurrently fork separate nodes from the same history.
  const retryLocks = new Map<string, string>();
  const interrupted: WorkflowRunDto[] = [];
  for (const raw of state.runs ?? []) {
    const run = clone(raw);
    if (run.status === "running") {
      run.status = "stopped";
      run.interrupted = true;
      run.finishedAt = now();
      for (const node of run.nodes) {
        // A fix only exists inside the process that held the unit.
        delete node.needsFix;
        delete node.needsDecision;
        if (node.status !== "done") {
          node.status = "stopped";
          node.retryable = false;
          node.error =
            "interrupted while child runtime release was unconfirmed";
        }
      }
      interrupted.push(run);
    }
    records.set(run.id, run);
  }
  const preferences = new Map(Object.entries(state.preferences ?? {}));
  const operations = new Map(Object.entries(state.operations ?? {}));
  // Runs saved before launchers were recorded have none. Any that were still
  // running were stopped above and never continue; such a run counts as system
  // work only for what it already did, and a retry of it belongs to whoever
  // asks for the retry.
  const launchers = new Map(Object.entries(state.launchers ?? {}));
  const routes = new Map(Object.entries(state.routes ?? {}));
  /** Units a running run holds for a person, per `${runId}:${nodeId}`. */
  const holds = new Map<string, (route: WorkflowNodeRoute | null) => void>();
  /** Review gates a running run holds for a person, per `${runId}:${nodeId}`. */
  const decisionHolds = new Map<string, (choice: DecisionChoice | null) => void>();
  const decisionOperations = new Map<string, { runId: string; fingerprint: string }>();
  /** In-place fixes already applied, per client operation, so a lost
   * response repeats nothing. Process-local like the holds themselves. */
  const fixOperations = new Map<string, { runId: string; fingerprint: string }>();
  // Synchronous reservation closes the same-process lost-response race before
  // the first awaited context/event operation. The durable operation row is
  // written with the run snapshot before execution begins.
  const reserved = new Set<string>();
  const inFlight = new Map<string, PendingOperation>();
  const progressAt = new Map<string, number>();
  /** Node state as the parent log last saw it, per `${runId}:${nodeId}`.
   *  Progress events carry only the fields that changed since this snapshot;
   *  a key with no snapshot (first publish, or after a process restart)
   *  publishes the complete node. */
  const published = new Map<string, WorkflowRunNodeDto>();
  const save = () => {
    mkdirSync(dirname(deps.file), { recursive: true });
    atomicWriteSync(
      deps.file,
      `${JSON.stringify(
        {
          v: 1,
          workflows,
          runs: [...records.values()],
          preferences: Object.fromEntries(preferences),
          operations: Object.fromEntries(operations),
          launchers: Object.fromEntries(launchers),
          ...(routes.size ? { routes: Object.fromEntries(routes) } : {}),
        },
        null,
        2
      )}\n`
    );
  };
  const withRoutes = (workflow: WorkflowDto): WorkflowDto => {
    const saved = workflow.builtin ? routes.get(workflow.id) : undefined;
    if (!saved) return workflow;
    return {
      ...workflow,
      nodes: workflow.nodes.map((node) => saved[node.id] ? routed(node, saved[node.id]!) : node),
    };
  };
  if ((state.runs ?? []).some((run) => run.status === "running")) save();
  if (interrupted.length > 0) {
    try {
      deps.onInterruptedRunsRecovered?.(interrupted);
    } catch (cause) {
      console.warn("[workflow] interrupted run reconciliation failed", cause);
    }
  }
  const mustGet = (id: string) => {
    const bundled = workflows.some((w) => w.id === id) ? null : deps.builtin?.(id);
    const found = workflows.find((w) => w.id === id) ?? (bundled ? withRoutes(bundled) : null);
    if (!found) throw error("workflow not found", "not-found");
    return found;
  };
  /** Keep `route` on the template `workflowId` for every later run: a saved
   * template changes in place, a bundled one keeps it as this project's route
   * for that unit. Throws when the template no longer has the unit. */
  const saveRoute = (workflowId: string, nodeId: string, route: WorkflowNodeRoute) => {
    const stored = workflows.find((w) => w.id === workflowId);
    if (stored) {
      const index = stored.nodes.findIndex((node) => node.id === nodeId);
      if (index < 0) throw error("this agent is no longer in the workflow; retry without saving", "conflict");
      const before = clone(stored);
      stored.nodes[index] = routed(stored.nodes[index]!, route);
      stored.revision = (stored.revision ?? 0) + 1;
      stored.updatedAt = now();
      try {
        save();
      } catch (cause) {
        restore(stored, before);
        throw cause;
      }
      return;
    }
    const bundled = deps.builtin?.(workflowId);
    if (!bundled?.nodes.some((node) => node.id === nodeId))
      throw error("this agent is no longer in the workflow; retry without saving", "conflict");
    const previous = routes.get(workflowId);
    routes.set(workflowId, { ...previous, [nodeId]: { ...previous?.[nodeId], ...clone(route) } });
    try {
      save();
    } catch (cause) {
      if (previous) routes.set(workflowId, previous);
      else routes.delete(workflowId);
      throw cause;
    }
  };

  const patchNode = async (
    owner: ActiveRun,
    id: string,
    patch: WorkflowNodeUpdate
  ) => {
    const node = owner.run.nodes.find((entry) => entry.id === id);
    if (!node) return;
    const before = clone(node);
    const next = { ...node, ...patch };
    const timestamp = now();
    const key = `${owner.run.id}:${id}`;
    const previous = progressAt.get(key) ?? 0;
    const durable = Object.keys(patch).some(
      (name) => name !== "activity" && name !== "output"
    );
    // Throttling may drop progress, never the start or end of a person's
    // turn: a dropped end would leave "waiting for you" on screen.
    const humanWaitChanged = HUMAN_WAIT.test(node.activity ?? "") !== HUMAN_WAIT.test(next.activity ?? "");
    const shouldPublish = durable || humanWaitChanged || timestamp - previous >= 250;
    if (shouldPublish) {
      // A full snapshot repeated the static prompt and the whole accumulated
      // output on every throttled update: one run made ~11 MB of parent
      // history that every open paged back in. Publish the delta instead;
      // the reducer merges `partial` events and replaces on legacy ones.
      // The snapshot advances before the append so a concurrent update of the
      // same node diffs against this one, not against the same older base
      // (two deltas from one base would repeat streamed output). A failed
      // append drops it: the next publish is a full snapshot again.
      const payload = progressPayload(published.get(key), next);
      published.set(key, clone(next));
      try {
        await deps.append(
          owner.parentSessionId,
          "workflow/node-progress",
          json({ runId: owner.run.id, nodeId: id, ...payload }),
          { ignorable: true, producerPlugin: "workflow" }
        );
      } catch (cause) {
        published.delete(key);
        throw cause;
      }
      progressAt.set(key, timestamp);
    }
    Object.assign(node, patch);
    records.set(owner.run.id, owner.run);
    if (durable) {
      try {
        save();
      } catch (cause) {
        restore(node, before);
        records.set(owner.run.id, owner.run);
        throw cause;
      }
    }
  };
  /** A review sent work back: the unit re-runs on this round with these
   * reports (findings for an executor, reworked reports for a review or any
   * other unit that already consumed the reworked output). */
  interface Rework {
    round: number;
    sources: WorkflowPromptSource[];
    /** The person's note when they asked for a round beyond the limit. */
    guidance?: string;
  }
  interface DecisionChoice {
    action: "accept" | "another-round";
    note?: string;
  }
  /** Wait for a person to settle a review gate: their choice, or null once
   * the run stops (`timedOut` false) or the deadline passes (`timedOut`). */
  const holdForDecision = (owner: ActiveRun, nodeId: string, timeoutMs: number) =>
    new Promise<{ choice: DecisionChoice | null; timedOut: boolean }>((resolve) => {
      const key = `${owner.run.id}:${nodeId}`;
      const signal = owner.controller.signal;
      let timedOut = false;
      const done = (choice: DecisionChoice | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stopped);
        decisionHolds.delete(key);
        resolve({ choice, timedOut });
      };
      const stopped = () => done(null);
      const timer = setTimeout(() => {
        timedOut = true;
        done(null);
      }, timeoutMs);
      // A held gate waits on a person, never keeps a process alive by itself.
      (timer as { unref?: () => void }).unref?.();
      if (signal.aborted) return done(null);
      signal.addEventListener("abort", stopped, { once: true });
      decisionHolds.set(key, done);
    });
  /** Wait for a person to fix a held unit: their route, or null once the run
   * stops or the unit's own deadline passes without one. */
  const holdForFix = (owner: ActiveRun, nodeId: string, timeoutMs: number) =>
    new Promise<WorkflowNodeRoute | null>((resolve) => {
      const key = `${owner.run.id}:${nodeId}`;
      const signal = owner.controller.signal;
      const done = (route: WorkflowNodeRoute | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stopped);
        holds.delete(key);
        resolve(route);
      };
      const stopped = () => done(null);
      const timer = setTimeout(stopped, timeoutMs);
      // A held unit waits on a person, never keeps a process alive by itself.
      (timer as { unref?: () => void }).unref?.();
      if (signal.aborted) return done(null);
      signal.addEventListener("abort", stopped, { once: true });
      holds.set(key, done);
    });
  const executeNode = async (
    owner: ActiveRun,
    node: WorkflowNodeDto,
    opts: Required<WorkflowRunOptionsDto>,
    layerOrder: Map<string, number>,
    rework?: Rework,
    /** Set when a person fixed this unit while the run held it. */
    fixed?: { fresh: boolean }
  ): Promise<void> => {
    const row = owner.run.nodes.find((entry) => entry.id === node.id);
    if (!row || owner.controller.signal.aborted) return;
    // Only a completed unit can be sent back; a first pass never repeats a
    // settled unit. A fixed unit resumes whichever pass it failed in.
    if (!fixed && (rework ? row.status !== "done" : row.status !== "queued")) return;
    const direct = upstream(owner.workflow, node.id);
    const blocked = direct.some((id) =>
      ["error", "skipped", "stopped"].includes(
        owner.run.nodes.find((n) => n.id === id)?.status ?? ""
      )
    );
    if (blocked) {
      await patchNode(owner, node.id, {
        status: "skipped",
        error: "upstream failed",
        retryable: false,
        finishedAt: now(),
      });
      return;
    }
    const sourceIds =
      opts.pipe === "direct"
        ? direct
        : [...ancestors(owner.workflow, node.id)].sort(
            (a, b) =>
              (layerOrder.get(a) ?? 0) - (layerOrder.get(b) ?? 0) ||
              a.localeCompare(b)
          );
    const sources = sourceIds.flatMap((id) => {
      const source = owner.workflow.nodes.find((n) => n.id === id);
      const result = owner.run.nodes.find((n) => n.id === id);
      return source && result?.output !== undefined
        ? [{ node: source, output: result.output, sessionId: result.sessionId, direct: direct.includes(id) }]
        : [];
    });
    const context = direct.length === 0 ? owner.run.context : undefined;
    // The unit keeps working in its own child session, so its brief, the
    // request and its earlier work stay in that session's history. A new
    // route needs a new child: an existing one keeps the route it began on.
    const resumeSessionId = rework && row.sessionId && !fixed?.fresh ? row.sessionId : undefined;
    // Every pass, rework round included, acts for the person who started it.
    const launchedBy = launchers.get(owner.run.id);
    const prompt = rework
      ? buildReworkPrompt(node, owner.run.input, {
          round: rework.round,
          sources: rework.sources,
          resumed: !!resumeSessionId,
          ...(row.output ? { previousOutput: row.output } : {}),
          ...(rework.guidance ? { guidance: rework.guidance } : {}),
        }, { sources, ...(context ? { context } : {}), team: owner.workflow.nodes })
      : buildNodePrompt(node, owner.run.input, sources, context, owner.workflow.nodes);
    await patchNode(owner, node.id, {
      status: "running",
      startedAt: now(),
      activity: resumeSessionId ? "resuming session" : "starting session",
      prompt,
      retryable: false,
      attempt: (row.attempt ?? 0) + 1,
      round: rework?.round ?? 1,
      ...(rework
        ? {
            verdict: undefined,
            judgment: undefined,
            findings: undefined,
            needsDecision: undefined,
            decision: undefined,
            disputes: undefined,
            error: undefined,
            finishedAt: undefined,
          }
        : {}),
    });
    try {
      const result = await deps.runNode(
        {
          parentSessionId: owner.parentSessionId,
          runId: owner.run.id,
          workflowId: owner.workflow.id,
          projectId: owner.workflow.projectId,
          node,
          prompt,
          permissions: opts.permissions,
          timeoutMs: opts.nodeTimeoutMs,
          signal: owner.controller.signal,
          attempt: row.attempt,
          context,
          ...(rework ? { round: rework.round } : {}),
          ...(resumeSessionId ? { resumeSessionId } : {}),
          ...(launchedBy ? { launchedBy } : {}),
        },
        (patch) => patchNode(owner, node.id, patch)
      );
      if (!owner.controller.signal.aborted && !result.output.trim()) {
        throw error("Workflow node completed without an assistant result.");
      }
      let verdictOutcome: JudgedVerdictOutcome | undefined;
      const findings = node.kind === "review" ? parseReviewFindings(result.output) : [];
      const disputes = isExecutorNode(node) ? parseDisputes(result.output) : [];
      if (node.kind === "review" && !owner.controller.signal.aborted) {
        const judgmentService = typeof deps.judgment === "function" ? deps.judgment() : deps.judgment;
        // Structured findings decide: the blockers among them, whatever the
        // verdict line says. Judgment is only for a report that lists none.
        const byFindings = verdictFromFindings(findings);
        verdictOutcome = byFindings
          ? { verdict: byFindings }
          : await resolveReviewVerdict({
              output: result.output,
              judgment: judgmentService,
              space: deps.spaceFor ? deps.spaceFor(launchedBy) : deps.space,
              projectId: owner.workflow.projectId,
              sessionId: result.sessionId,
              signal: owner.controller.signal,
            });
      }
      await patchNode(
        owner,
        node.id,
        owner.controller.signal.aborted
          ? {
              status: "stopped",
              activity: undefined,
              finishedAt: now(),
              retryable: false,
              ...(result.sessionId ? { sessionId: result.sessionId } : {}),
            }
          : {
              status: "done",
              output: result.output,
              activity: undefined,
              finishedAt: now(),
              retryable: false,
              ...(result.sessionId ? { sessionId: result.sessionId } : {}),
              ...(node.kind === "review"
                ? {
                    ...(verdictOutcome?.verdict !== undefined ? { verdict: verdictOutcome.verdict } : {}),
                    ...(verdictOutcome?.judgment !== undefined ? { judgment: verdictOutcome.judgment } : {}),
                    findings: findings.length ? findings : undefined,
                  }
                : { disputes: disputes.length ? disputes : undefined }),
            }
      );
    } catch (cause) {
      const stopped =
        owner.controller.signal.aborted ||
        (cause as { name?: string })?.name === "AbortError";
      const failure = (cause as { workflow?: { retryable?: unknown; phase?: unknown; fixable?: unknown } })?.workflow;
      const retryable = !stopped && failure?.retryable === true;
      // Proven never to have started (a refused model, an unavailable
      // harness): the run waits for a person to fix the unit instead of
      // failing everything after it.
      const waitsForFix = retryable && failure?.phase === "pre-admission" && failure.fixable !== false;
      await patchNode(
        owner,
        node.id,
        stopped
          ? {
              status: "stopped",
              activity: undefined,
              finishedAt: now(),
              retryable: false,
            }
          : {
              status: "error",
              activity: undefined,
              error: (cause instanceof Error
                ? cause.message
                : String(cause)
              ).slice(0, 500),
              finishedAt: now(),
              retryable,
              ...(waitsForFix ? { needsFix: true } : {}),
            }
      );
      if (!waitsForFix) return;
      const route = await holdForFix(owner, node.id, opts.nodeTimeoutMs);
      if (!route) {
        // No fix: the unit stays failed and the settled run can still fork it.
        await patchNode(owner, node.id, { needsFix: undefined }).catch(() => undefined);
        return;
      }
      const current = owner.workflow.nodes.find((entry) => entry.id === node.id) ?? node;
      await executeNode(owner, current, opts, layerOrder, rework, {
        fresh: Object.keys(route).length > 0,
      });
    }
  };
  /** After a stage settles, every review in it that requested changes sends
   * its findings back to the executors directly before it. Those executors
   * rework in their own sessions, every completed unit downstream of them
   * (the review included) re-runs on the new output, and the review decides
   * again. The run moves on once every review approves, a review stops
   * asking, or the configured rounds are spent; a verdict still requesting
   * changes then stays visible on the unit and in the parent's context. */
  const reviewLoop = async (
    owner: ActiveRun,
    opts: Required<WorkflowRunOptionsDto>,
    layerOrder: Map<string, number>,
    layerIndex: number
  ) => {
    const graph = owner.workflow;
    const rowOf = (id: string) => owner.run.nodes.find((entry) => entry.id === id);
    const sourceOf = (id: string): WorkflowPromptSource | undefined => {
      const node = graph.nodes.find((entry) => entry.id === id);
      const row = rowOf(id);
      return node && row?.output !== undefined
        ? { node, output: row.output, direct: true, ...(row.sessionId ? { sessionId: row.sessionId } : {}) }
        : undefined;
    };
    if (opts.reviewRounds < 1) return;
    /** Rounds a person granted beyond the limit, and their notes, per gate. */
    const extras = new Map<string, number>();
    const notes = new Map<string, string>();
    const allowed = (id: string) => opts.reviewRounds + (extras.get(id) ?? 0);
    const layerGates = () => graph.nodes.filter((node) => node.kind === "review"
      && layerOrder.get(node.id) === layerIndex
      && rowOf(node.id)?.status === "done");
    // Gates still asking for changes that have someone to send them to and no
    // final decision. A gate the person accepted or let time out is settled.
    const pending = () => layerGates().filter((node) => {
      const row = rowOf(node.id);
      return row?.verdict === "changes-requested"
        && row.decision !== "accepted" && row.decision !== "timed-out"
        && reworkTargets(graph, node.id).some((id) => rowOf(id)?.status === "done");
    });
    const announceLimit = async () => {
      for (const gate of layerGates())
        await patchNode(owner, gate.id, { roundLimit: allowed(gate.id) + 1 });
    };
    await announceLimit();
    for (let round = 2; ; round++) {
      if (owner.controller.signal.aborted) return;
      let gates = pending().filter((gate) => round - 1 <= allowed(gate.id));
      const stalled = pending().filter((gate) => !gates.includes(gate));
      if (stalled.length) {
        // The rounds are spent and a gate still requests changes: never move
        // on silently. The run holds each such gate for the person.
        const choices = await Promise.all(stalled.map((gate) =>
          arbitrate(owner, opts, gate, graph, (extras.get(gate.id) ?? 0) < MAX_EXTRA_ROUNDS)));
        if (owner.controller.signal.aborted) return;
        stalled.forEach((gate, index) => {
          const choice = choices[index];
          if (choice?.action !== "another-round") return;
          extras.set(gate.id, (extras.get(gate.id) ?? 0) + 1);
          if (choice.note) notes.set(gate.id, choice.note);
        });
        await announceLimit();
        gates = pending().filter((gate) => round - 1 <= allowed(gate.id));
      }
      if (!gates.length) return;
      const targets = new Set(gates.flatMap((gate) => reworkTargets(graph, gate.id))
        .filter((id) => rowOf(id)?.status === "done"));
      if (!targets.size) return;
      const affected = new Set([...descendants(graph, [...targets])]
        .filter((id) => (layerOrder.get(id) ?? Infinity) <= layerIndex && rowOf(id)?.status === "done"));
      const plan = new Map<number, string[]>();
      for (const id of [...targets, ...affected]) {
        const layer = layerOrder.get(id) ?? 0;
        plan.set(layer, [...(plan.get(layer) ?? []), id]);
      }
      const guidanceFor = (id: string): string | undefined => {
        const text = gates.filter((gate) => reworkTargets(graph, gate.id).includes(id))
          .map((gate) => notes.get(gate.id)).filter((note): note is string => !!note).join("\n\n");
        return text || undefined;
      };
      for (const layer of [...plan.keys()].sort((a, b) => a - b)) {
        if (owner.controller.signal.aborted) return;
        await pool(plan.get(layer)!, opts.maxParallel, owner.controller.signal, async (id) => {
          const node = graph.nodes.find((entry) => entry.id === id);
          if (!node) return;
          const sources = targets.has(id)
            // An executor receives every review that sent it work back.
            ? gates.filter((gate) => reworkTargets(graph, gate.id).includes(id))
              .map((gate) => sourceOf(gate.id))
            // A dependent re-runs on the reworked reports before it.
            : upstream(graph, id).filter((source) => targets.has(source) || affected.has(source))
              .map(sourceOf);
          const guidance = targets.has(id) ? guidanceFor(id) : undefined;
          await executeNode(owner, node, opts, layerOrder, {
            round,
            sources: sources.filter((source): source is WorkflowPromptSource => !!source),
            ...(guidance ? { guidance } : {}),
          });
        });
      }
      for (const gate of gates) notes.delete(gate.id);
    }
  };
  /** Hold one gate whose rounds are spent for the person's decision, putting
   * each open blocker next to the builder's reply to it. Resolves with their
   * choice, or null when the run stopped or the deadline passed (the gate
   * then keeps its verdict and the run moves on, as it always did). */
  const arbitrate = async (
    owner: ActiveRun,
    opts: Required<WorkflowRunOptionsDto>,
    gate: WorkflowNodeDto,
    graph: WorkflowDto,
    canAnotherRound: boolean
  ): Promise<DecisionChoice | null> => {
    const row = owner.run.nodes.find((entry) => entry.id === gate.id);
    if (!row) return null;
    const disputes = reworkTargets(graph, gate.id)
      .flatMap((id) => owner.run.nodes.find((entry) => entry.id === id)?.disputes ?? []);
    const items = (row.findings ?? []).filter((finding) => finding.severity === "blocker")
      .map((finding) => {
        const reply = matchDispute(finding, disputes)?.reason;
        return { finding, ...(reply ? { reply } : {}) };
      });
    await patchNode(owner, gate.id, { needsDecision: { items, canAnotherRound } });
    try {
      deps.onReviewSettled?.({
        runId: owner.run.id,
        parentSessionId: owner.parentSessionId,
        outcome: "needs-decision",
        rounds: row.round ?? 1,
      });
    } catch {
      // Delivery only: a lost notification never changes the run.
    }
    const held = await holdForDecision(owner, gate.id, deps.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS);
    if (owner.controller.signal.aborted) return null;
    if (held.choice) return held.choice;
    if (held.timedOut)
      await patchNode(owner, gate.id, { needsDecision: undefined, decision: "timed-out" }).catch(() => undefined);
    return null;
  };
  const execute = async (
    owner: ActiveRun,
    opts: Required<WorkflowRunOptionsDto>
  ) => {
    const order = new Map(
      owner.run.layers.flatMap((ids, index) =>
        ids.map((id) => [id, index] as const)
      )
    );
    for (const [layerIndex, layer] of owner.run.layers.entries()) {
      if (owner.controller.signal.aborted) break;
      await pool(
        layer,
        opts.maxParallel,
        owner.controller.signal,
        async (id) => {
          const node = owner.workflow.nodes.find((n) => n.id === id);
          if (node) await executeNode(owner, node, opts, order);
        }
      );
      await reviewLoop(owner, opts, order, layerIndex);
    }
    for (const node of owner.run.nodes)
      if (node.status === "queued" || node.status === "running")
        await patchNode(owner, node.id, {
          status: "stopped",
          activity: undefined,
          finishedAt: now(),
          retryable: false,
        });
    const status: WorkflowRunStatus = owner.controller.signal.aborted
      || owner.run.nodes.some((n) => n.status === "stopped")
      ? "stopped"
      : owner.run.nodes.some((n) => n.status !== "done")
      ? "error"
      : "done";
    const terminals = owner.workflow.nodes
      .filter((n) => !owner.workflow.edges.some((edge) => edge.source === n.id))
      .map((n) => n.id);
    const result = terminals
      .map((id) => owner.run.nodes.find((n) => n.id === id)?.output)
      .filter((x): x is string => Boolean(x?.trim()))
      .join("\n\n")
      .slice(0, MAX_CONTEXT);
    const finishedAt = now();
    // Once this append starts, a thrown response cannot prove that the
    // canonical terminal event was rejected. Keep the durable running marker
    // and let restart fencing reconcile it; never append a guessed fallback.
    owner.terminalEventAttempted = true;
    await deps.append(
      owner.parentSessionId,
      "workflow/run-completed",
      json({
        runId: owner.run.id,
        status,
        finishedAt,
        ...(result ? { result } : {}),
        ...(owner.run.interrupted ? { interrupted: true } : {}),
      }),
      { ignorable: true, producerPlugin: "workflow" }
    );
    owner.terminalEventAccepted = true;
    // One notice that the review concluded: only when every review approved.
    // A gate held for a person has already said so, and a settled run's own
    // completion is announced by the parent chat.
    const reviewRows = owner.run.nodes.filter((node) => owner.workflow.nodes.find((n) => n.id === node.id)?.kind === "review");
    if (reviewRows.length && !owner.controller.signal.aborted
      && reviewRows.every((node) => node.status === "done" && node.verdict === "approved")) {
      try {
        deps.onReviewSettled?.({
          runId: owner.run.id,
          parentSessionId: owner.parentSessionId,
          outcome: "approved",
          rounds: Math.max(...reviewRows.map((node) => node.round ?? 1)),
        });
      } catch {
        // Delivery only.
      }
    }
    // The parent chat's agent continues from this record: every settled run
    // publishes its request, outcome, units and result, including partial ones.
    try {
      await deps.append(
        owner.parentSessionId,
        "package/context",
        json({
          packageId: "workflow",
          sourceId: `run:${owner.run.id}`,
          title: `Workflow "${owner.workflow.name}" ${status === "done" ? "result" : status === "error" ? "failed" : "stopped"}`,
          text: workflowContextText(owner.run, status, result),
          runId: owner.run.id,
        }),
        { producerPlugin: "workflow" }
      );
    } catch {
      // The run-completed event above is the canonical terminal boundary;
      // a context index/update failure must not append a contradictory error
      // event or project a local-only failure after completion is durable.
    }
    // Expose and persist the terminal projection only after its canonical
    // model-visible event has been durably accepted.
    owner.run.status = status;
    owner.run.finishedAt = finishedAt;
    if (status !== "stopped") delete owner.run.interrupted;
    if (result) owner.run.result = result;
    records.set(owner.run.id, owner.run);
    try {
      save();
    } catch (cause) {
      // The terminal event is already canonical. Keep the terminal projection
      // in memory when its local snapshot fails; a restart will fence the
      // stale running snapshot rather than emit a contradictory completion.
      throw cause;
    }
  };
  const makeRun = async (
    workflow: WorkflowDto,
    sessionId: string,
    input: string,
    opts: Required<WorkflowRunOptionsDto>,
    launch?: WorkflowLaunchOptionsDto,
    retryOf?: string,
    launchedBy?: string
  ): Promise<WorkflowRunDto> => {
    const layers = validate(workflow);
    // Retries reuse the original admitted context verbatim. Re-reading the
    // parent session here could select newer history or attachments and would
    // make a retry a different request.
    const context = retryOf
      ? undefined
      : contextOf(await deps.buildContext?.(sessionId, launch, input, launchedBy));
    return {
      id: randomUUID(),
      workflowId: workflow.id,
      projectId: workflow.projectId,
      parentSessionId: sessionId.trim(),
      name: workflow.name,
      input: input.trim(),
      options: opts,
      status: "running",
      startedAt: now(),
      layers,
      definition: clone(workflow),
      ...(launch?.clientOperationId
        ? { clientOperationId: launch.clientOperationId }
        : {}),
      ...(context ? { context } : {}),
      ...(retryOf ? { retryOf } : {}),
      nodes: workflow.nodes.map((node) => ({
        id: node.id,
        role: node.role,
        status: "queued",
        attempt: 0,
        retryable: false,
        ...(node.model ? { model: node.model } : {}),
        ...(node.agent ? { agent: node.agent } : {}),
        ...(node.harness ? { harness: clone(node.harness) } : {}),
        ...(node.group ? { group: node.group } : {}),
      })),
    };
  };
  const begin = (run: WorkflowRunDto, workflow: WorkflowDto) => {
    const owner: ActiveRun = {
      parentSessionId: run.parentSessionId!,
      workflow,
      run,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    active.set(run.id, owner);
    owner.done = execute(owner, run.options!)
      .catch(async (cause) => {
        if (
          run.status !== "running" ||
          owner.terminalEventAttempted ||
          owner.terminalEventAccepted
        )
          return;
        const finishedAt = now();
        owner.terminalEventAttempted = true;
        try {
          await deps.append(
            owner.parentSessionId,
            "workflow/run-completed",
            json({
              runId: run.id,
              status: "error",
              finishedAt,
              error: cause instanceof Error ? cause.message : String(cause),
            }),
            { ignorable: true, producerPlugin: "workflow" }
          );
        } catch {
          // Without the canonical terminal event, keep the durable run
          // recoverable instead of exposing a local-only terminal projection.
          return;
        }
        owner.terminalEventAccepted = true;
        run.status = "error";
        run.finishedAt = finishedAt;
        records.set(run.id, run);
        try {
          save();
        } catch (saveCause) {
          // The fallback terminal event was accepted. Keep the in-memory
          // terminal projection when only its local snapshot failed.
          throw saveCause;
        }
      })
      .finally(() => {
        active.delete(run.id);
        for (const node of run.nodes) {
          published.delete(`${run.id}:${node.id}`);
          progressAt.delete(`${run.id}:${node.id}`);
        }
      });
    return owner.done;
  };

  return {
    list(projectId) {
      return workflows
        .filter((w) => !projectId || w.projectId === projectId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(clone);
    },
    get(id) {
      const found = workflows.find((w) => w.id === id);
      return found ? clone(found) : null;
    },
    withRoutes(workflow) {
      return clone(withRoutes(workflow));
    },
    create(input) {
      validate(input);
      const timestamp = now();
      const workflow: WorkflowDto = {
        id: randomUUID(),
        projectId: input.projectId.trim(),
        name: input.name.trim(),
        ...(input.description?.trim()
          ? { description: input.description.trim() }
          : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.profile ? { profile: input.profile } : {}),
        ...(input.preset ? { preset: clone(input.preset) } : {}),
        nodes: clone(input.nodes),
        edges: clone(input.edges),
        ...(input.defaults ? { defaults: clone(input.defaults) } : {}),
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      workflows.push(workflow);
      try {
        save();
      } catch (cause) {
        workflows.pop();
        throw cause;
      }
      return clone(workflow);
    },
    update(id, patch) {
      const current = mustGet(id);
      if (current.builtin)
        throw error(
          "built-in workflows are read-only; duplicate it first",
          "conflict"
        );
      const revision = current.revision ?? 0;
      if (
        patch.expectedRevision !== undefined &&
        patch.expectedRevision !== revision
      )
        throw error("workflow revision is stale", "conflict");
      const candidate: WorkflowCreateInput = {
        projectId: current.projectId,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        category: patch.category ?? current.category,
        profile: patch.profile ?? current.profile,
        nodes: patch.nodes ?? current.nodes,
        edges: patch.edges ?? current.edges,
        defaults: patch.defaults ?? current.defaults,
      };
      validate(candidate);
      const before = clone(current);
      current.name = candidate.name.trim();
      current.nodes = clone(candidate.nodes);
      current.edges = clone(candidate.edges);
      current.updatedAt = now();
      current.revision = revision + 1;
      if (candidate.description === undefined) delete current.description;
      else current.description = candidate.description.trim();
      if (candidate.category === undefined) delete current.category;
      else current.category = candidate.category;
      if (candidate.profile === undefined) delete current.profile;
      else current.profile = candidate.profile;
      if (candidate.defaults === undefined) delete current.defaults;
      else current.defaults = clone(candidate.defaults);
      try {
        save();
      } catch (cause) {
        Object.assign(current, before);
        throw cause;
      }
      return clone(current);
    },
    remove(id) {
      const before = workflows.length;
      const previous = workflows;
      workflows = workflows.filter((w) => w.id !== id || w.builtin);
      if (workflows.length !== before) {
        try {
          save();
        } catch (cause) {
          workflows = previous;
          throw cause;
        }
      }
      return workflows.length !== before;
    },
    async start(workflowId, sessionId, input, override, launch, launchedBy) {
      validateLaunch(launch);
      const workflow = applyLaunchDefaults(clone(mustGet(workflowId)), launch);
      if (!sessionId.trim()) throw error("sessionId is required");
      if (!input.trim()) throw error("workflow input is required");
      const op = launch?.clientOperationId;
      const startFingerprint = JSON.stringify({
        workflowId,
        sessionId,
        input: input.trim(),
        override,
        launch,
      });
      if (op) {
        const prior = operations.get(op);
        if (prior) {
          const existing = records.get(prior.runId);
          if (
            !existing ||
            prior.workflowId !== workflow.id ||
            existing.parentSessionId !== sessionId ||
            existing.projectId !== workflow.projectId ||
            existing.input !== input.trim() ||
            (prior.fingerprint !== undefined &&
              prior.fingerprint !== startFingerprint)
          )
            throw error(
              "clientOperationId was already used for a different workflow",
              "conflict"
            );
          return clone(existing);
        }
        const pending = inFlight.get(op);
        if (pending) {
          if (pending.fingerprint !== startFingerprint)
            throw error(
              "clientOperationId was already used for a different workflow",
              "conflict"
            );
          const existing = await pending.promise;
          return clone(existing);
        }
      }
      const work = (async (): Promise<WorkflowRunDto> => {
        if (op) {
          if (reserved.has(op))
            throw error(
              "workflow launch is already being admitted",
              "conflict"
            );
          reserved.add(op);
        }
        let run: WorkflowRunDto;
        try {
          run = await makeRun(
            workflow,
            sessionId,
            input,
            options(workflow.defaults, override),
            launch,
            undefined,
            launchedBy
          );
        } catch (cause) {
          if (op) reserved.delete(op);
          throw cause;
        }
        // Persist the immutable admission marker before the start event. If
        // event delivery is uncertain, a retry returns this same run and does
        // not execute a second paid child turn.
        records.set(run.id, run);
        if (launchedBy) launchers.set(run.id, launchedBy);
        if (op)
          operations.set(op, {
            runId: run.id,
            workflowId: workflow.id,
            input: run.input,
            fingerprint: startFingerprint,
          });
        try {
          save();
        } catch (cause) {
          records.delete(run.id);
          launchers.delete(run.id);
          if (op) operations.delete(op);
          if (op) reserved.delete(op);
          throw cause;
        }
        try {
          await deps.append(
            sessionId,
            "workflow/run-started",
            json({
              runId: run.id,
              workflowId: run.workflowId,
              projectId: run.projectId,
              parentSessionId: run.parentSessionId,
              name: run.name,
              input: run.input,
              options: run.options,
              startedAt: run.startedAt,
              layers: run.layers,
              nodes: run.nodes,
              definition: run.definition,
              ...(run.clientOperationId
                ? { clientOperationId: run.clientOperationId }
                : {}),
              ...(run.context ? { context: run.context } : {}),
            }),
            { ignorable: true, producerPlugin: "workflow" }
          );
        } finally {
          // The durable operation row is the retry authority even when event
          // delivery loses its response, so the process-local reservation can
          // never strand a later exact retry.
          if (op) reserved.delete(op);
        }
        if (op) reserved.delete(op);
        void begin(run, workflow).catch(() => {});
        try {
          deps.onRunStarted?.(clone(run), launchedBy);
        } catch {
          // Naming the parent is cosmetic and never fails an admitted run.
        }
        return clone(run);
      })();
      if (op) {
        inFlight.set(op, { fingerprint: startFingerprint, promise: work });
        try {
          return await work;
        } finally {
          if (inFlight.get(op)?.promise === work) inFlight.delete(op);
        }
      }
      return work;
    },
    listRuns(projectId) {
      return [...records.values()]
        .filter((run) => !projectId || run.projectId === projectId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(clone);
    },
    getRun(id) {
      const run = records.get(id);
      return run ? clone(run) : null;
    },
    async stop(id) {
      const owner = active.get(id);
      if (!owner) {
        const run = records.get(id);
        if (!run) throw error("workflow run not found", "not-found");
        return clone(run);
      }
      if (owner.run.status === "running") owner.controller.abort();
      await owner.done;
      return clone(owner.run);
    },
    async decide(id, input, requestedBy) {
      const record = records.get(id);
      if (!record) throw error("workflow run not found", "not-found");
      const nodeId = typeof input?.nodeId === "string" ? input.nodeId : "";
      if (input?.action !== "accept" && input?.action !== "another-round")
        throw error("action must be accept or another-round");
      if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > MAX_DECISION_NOTE))
        throw error(`note must be text of at most ${MAX_DECISION_NOTE} characters`);
      if (input.note !== undefined && input.action !== "another-round")
        throw error("a note only goes with another-round");
      if (input.clientOperationId !== undefined && (typeof input.clientOperationId !== "string" || input.clientOperationId.length > 200))
        throw error("invalid clientOperationId");
      const note = input.note?.trim() || undefined;
      const fingerprint = JSON.stringify({ id, nodeId, action: input.action, note });
      const applied = input.clientOperationId ? decisionOperations.get(input.clientOperationId) : undefined;
      if (applied) {
        if (applied.fingerprint !== fingerprint)
          throw error("clientOperationId was already used for a different decision", "conflict");
        return clone(records.get(applied.runId)!);
      }
      const row = record.nodes.find((node) => node.id === nodeId);
      if (!row) throw error("workflow unit not found", "not-found");
      const launcher = launchers.get(id);
      if (requestedBy && launcher && requestedBy !== launcher)
        throw error("only the person who started this run can decide its review", "conflict");
      const decision = input.action === "accept" ? "accepted" : "another-round";
      const release = decisionHolds.get(`${id}:${nodeId}`);
      const owner = active.get(id);
      if (!owner || owner.run.status !== "running" || !release || !row.needsDecision) {
        // The same decision again is a repeat, not an error.
        if (row.decision === decision && !row.needsDecision) return clone(record);
        throw error("this review is not waiting for a decision", "conflict");
      }
      if (input.action === "another-round" && !row.needsDecision.canAnotherRound)
        throw error("no more extra rounds are available; accept the work or stop the run", "conflict");
      // Claim the hold first: a second request must not decide twice.
      decisionHolds.delete(`${id}:${nodeId}`);
      try {
        await patchNode(owner, nodeId, { needsDecision: undefined, decision });
      } catch (cause) {
        decisionHolds.set(`${id}:${nodeId}`, release);
        throw cause;
      }
      if (input.clientOperationId) decisionOperations.set(input.clientOperationId, { runId: id, fingerprint });
      release({ action: input.action, ...(note ? { note } : {}) });
      return clone(owner.run);
    },
    async retry(id, nodeId, clientOperationId, rawReplacement, requestedBy, retryOptions) {
      const original = records.get(id);
      if (!original) throw error("workflow run not found", "not-found");
      const route = routeOf(rawReplacement);
      const replacement = Object.keys(route).length ? route : undefined;
      const saveToWorkflow = retryOptions?.saveToWorkflow === true && !!replacement;
      // A unit the running run holds continues in place.
      const fixFingerprint = JSON.stringify({ original: id, nodeId, replacement, saveToWorkflow });
      const appliedFix = clientOperationId ? fixOperations.get(clientOperationId) : undefined;
      if (appliedFix) {
        if (appliedFix.fingerprint !== fixFingerprint || appliedFix.runId !== id)
          throw error("clientOperationId was already used for a different retry", "conflict");
        return clone(records.get(appliedFix.runId)!);
      }
      const owner = active.get(id);
      const release = holds.get(`${id}:${nodeId}`);
      if (owner && owner.run.status === "running" && release) {
        const launcher = launchers.get(id);
        if (requestedBy && launcher && requestedBy !== launcher)
          throw error("only the person who started this run can fix it while it runs; retry it once it settles", "conflict");
        // Claim the hold first: a second request for the same unit must not
        // apply its fix twice.
        holds.delete(`${id}:${nodeId}`);
        try {
          if (saveToWorkflow) saveRoute(owner.run.workflowId, nodeId, route);
        } catch (cause) {
          holds.set(`${id}:${nodeId}`, release);
          throw cause;
        }
        let next: WorkflowNodeDto | undefined;
        for (const graph of [owner.workflow, owner.run.definition]) {
          const index = graph?.nodes.findIndex((node) => node.id === nodeId) ?? -1;
          if (!graph || index < 0) continue;
          graph.nodes[index] = routed(graph.nodes[index]!, route);
          next ??= graph.nodes[index];
        }
        try {
          await patchNode(owner, nodeId, {
            status: "queued",
            needsFix: undefined,
            error: undefined,
            finishedAt: undefined,
            retryable: false,
            ...(next ? { model: next.model, harness: next.harness, agent: next.agent } : {}),
          });
        } catch (cause) {
          holds.set(`${id}:${nodeId}`, release);
          throw cause;
        }
        if (clientOperationId) fixOperations.set(clientOperationId, { runId: id, fingerprint: fixFingerprint });
        release(route);
        return clone(owner.run);
      }
      // The fork acts for whoever asks for it: re-running someone else's run
      // must never borrow their private harness accounts or identity. A
      // system retry (no person) keeps the original launcher.
      const launchedBy = requestedBy ?? launchers.get(original.id);
      const retryFingerprint = JSON.stringify({
        original: id,
        nodeId,
        replacement,
        ...(saveToWorkflow ? { saveToWorkflow } : {}),
      });
      const retryKey = id;
      if (clientOperationId) {
        const prior = operations.get(clientOperationId);
        if (prior && !records.has(prior.runId))
          throw error(
            "clientOperationId is bound to a missing workflow retry",
            "storage-error"
          );
        const pending = inFlight.get(clientOperationId);
        if (pending) {
          if (pending.fingerprint !== retryFingerprint)
            throw error(
              "clientOperationId was already used for a different retry",
              "conflict"
            );
          return clone(await pending.promise);
        }
        if (prior && records.has(prior.runId)) {
          if (
            prior.fingerprint !== undefined &&
            prior.fingerprint !== retryFingerprint
          )
            throw error(
              "clientOperationId was already used for a different retry",
              "conflict"
            );
          return clone(records.get(prior.runId)!);
        }
      }
      if (original.status === "running")
        throw error(
          "workflow retry is only available after the original run settles",
          "conflict"
        );
      const priorRetry = [...records.values()].find(
        (candidate) => candidate.retryOf === original.id
      );
      if (priorRetry)
        throw error(
          "this workflow already has a retry fork; retry the latest lineage",
          "conflict"
        );
      if (retryLocks.has(retryKey))
        throw error(
          "this workflow already has a retry fork in progress",
          "conflict"
        );
      retryLocks.set(retryKey, "admitting");
      const perform = async (): Promise<WorkflowRunDto> => {
        const failed = original.nodes.find((node) => node.id === nodeId);
        if (!failed || (failed.status !== "error" && failed.status !== "stopped"))
          throw error("only a failed or stopped node can be retried", "conflict");
        if (failed.retryable !== true)
          throw error(
            "retry is fenced until the child runtime release is confirmed",
            "conflict"
          );
        const workflow = clone(
          original.definition ?? mustGet(original.workflowId)
        );
        const targetIndex = workflow.nodes.findIndex((node) => node.id === nodeId);
        if (targetIndex < 0) throw error("workflow node not found", "not-found");
        if (replacement) workflow.nodes[targetIndex] = routed(workflow.nodes[targetIndex]!, replacement);
        if (saveToWorkflow) saveRoute(original.workflowId, nodeId, route);
        const restart = new Set<string>([nodeId]);
        const pending = [nodeId];
        while (pending.length) {
          const source = pending.pop()!;
          for (const edge of workflow.edges) {
            const downstream = original.nodes.find((node) => node.id === edge.target);
            if (
              edge.source === source &&
              downstream &&
              ["skipped", "stopped"].includes(downstream.status) &&
              !restart.has(edge.target)
            ) {
              restart.add(edge.target);
              pending.push(edge.target);
            }
          }
        }
        const run = await makeRun(
          workflow,
          original.parentSessionId!,
          original.input,
          original.options ?? options(workflow.defaults),
          undefined,
          original.id,
          launchedBy
        );
        run.context = clone(original.context);
        run.clientOperationId = clientOperationId;
        for (const prior of original.nodes) {
          const targetRow = run.nodes.find((node) => node.id === prior.id)!;
          if (prior.status === "done" || !restart.has(prior.id))
            Object.assign(targetRow, clone(prior));
          else targetRow.attempt = prior.attempt ?? 0;
          delete targetRow.needsFix;
        }
        records.set(run.id, run);
        if (launchedBy) launchers.set(run.id, launchedBy);
        if (clientOperationId)
          operations.set(clientOperationId, {
            runId: run.id,
            workflowId: run.workflowId,
            input: run.input,
            fingerprint: retryFingerprint,
          });
        try {
          save();
        } catch (cause) {
          records.delete(run.id);
          launchers.delete(run.id);
          if (clientOperationId) operations.delete(clientOperationId);
          try {
            save();
          } catch (rollbackCause) {
            // If the rollback itself cannot be persisted, retain the admitted
            // snapshot in memory so this process cannot issue a second retry
            // against an uncertain durable row.
            records.set(run.id, run);
            if (launchedBy) launchers.set(run.id, launchedBy);
            if (clientOperationId)
              operations.set(clientOperationId, {
                runId: run.id,
                workflowId: run.workflowId,
                input: run.input,
                fingerprint: retryFingerprint,
              });
            throw rollbackCause;
          }
          throw cause;
        }
        try {
          await deps.append(
            run.parentSessionId!,
            "workflow/run-started",
            json({
              runId: run.id,
              workflowId: run.workflowId,
              projectId: run.projectId,
              parentSessionId: run.parentSessionId,
              name: run.name,
              input: run.input,
              options: run.options,
              startedAt: run.startedAt,
              layers: run.layers,
              nodes: run.nodes,
              definition: run.definition,
              retryOf: original.id,
              ...(run.clientOperationId
                ? { clientOperationId: run.clientOperationId }
                : {}),
              ...(run.context ? { context: run.context } : {}),
            }),
            { ignorable: true, producerPlugin: "workflow" }
          );
        } catch (cause) {
          // The event store may have accepted the retry before the response
          // was lost. Keep the durable retry marker and operation binding so
          // an exact retry cannot create a second child turn.
          throw cause;
        }
        retryLocks.set(retryKey, run.id);
        const done = begin(run, workflow);
        const releaseRetryLock = () => {
          if (retryLocks.get(retryKey) === run.id) retryLocks.delete(retryKey);
        };
        void done.then(releaseRetryLock, releaseRetryLock);
        return clone(run);
      };
      if (clientOperationId) {
        const promise = perform();
        inFlight.set(clientOperationId, {
          fingerprint: retryFingerprint,
          promise,
        });
        try {
          return await promise;
        } catch (cause) {
          if (retryLocks.get(retryKey) === "admitting") retryLocks.delete(retryKey);
          throw cause;
        } finally {
          if (inFlight.get(clientOperationId)?.promise === promise)
            inFlight.delete(clientOperationId);
        }
      }
      try {
        return await perform();
      } catch (cause) {
        if (retryLocks.get(retryKey) === "admitting") retryLocks.delete(retryKey);
        throw cause;
      }
    },
    getPreferences(projectId) {
      return clone(
        preferences.get(projectId) ?? { pinnedIds: [], recentIds: [] }
      );
    },
    updatePreferences(projectId, patch) {
      if (!projectId.trim()) throw error("projectId is required");
      if (
        patch.category !== undefined &&
        ![
          "development",
          "visual",
          "research",
          "review",
          "devops",
          "general",
        ].includes(patch.category)
      )
        throw error("invalid workflow category");
      const current = clone(
        preferences.get(projectId) ?? { pinnedIds: [], recentIds: [] }
      );
      const ids = (value: unknown) =>
        Array.isArray(value)
          ? [
              ...new Set(
                value.filter(
                  (id): id is string =>
                    typeof id === "string" &&
                    id.length <= 300 &&
                    id !== "__proto__" &&
                    id !== "constructor" &&
                    id !== "prototype"
                )
              ),
            ].slice(0, 100)
          : undefined;
      const next: WorkflowPreferencesDto = {
        pinnedIds: ids(patch.pinnedIds) ?? current.pinnedIds,
        recentIds: ids(patch.recentIds) ?? current.recentIds,
        ...(patch.selectedId !== undefined
          ? {
              selectedId:
                typeof patch.selectedId === "string" &&
                patch.selectedId.length <= 300
                  ? patch.selectedId
                  : undefined,
            }
          : current.selectedId
          ? { selectedId: current.selectedId }
          : {}),
        ...(patch.category !== undefined
          ? { category: patch.category }
          : current.category
          ? { category: current.category }
          : {}),
      };
      preferences.set(projectId, next);
      try {
        save();
      } catch (cause) {
        if (
          current.pinnedIds.length ||
          current.recentIds.length ||
          current.selectedId ||
          current.category
        )
          preferences.set(projectId, current);
        else preferences.delete(projectId);
        throw cause;
      }
      return clone(next);
    },
  };
}
async function pool<T>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  work: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length && !signal.aborted) await work(queue.shift()!);
    })
  );
}
