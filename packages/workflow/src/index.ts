import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  JsonObject,
  WorkflowDto,
  WorkflowEdgeDto,
  WorkflowNodeDto,
  WorkflowPermissionPolicy,
  WorkflowPipeMode,
  WorkflowRunDto,
  WorkflowRunNodeDto,
  WorkflowRunOptionsDto,
  WorkflowRunStatus,
} from "@polyth/contracts";
import { ancestors, layerize, upstream } from "./graph.ts";
import { buildNodePrompt } from "./prompt.ts";

export { ancestors, layerize, upstream, wouldCycle } from "./graph.ts";
export { buildNodePrompt } from "./prompt.ts";
export type { LayerResult, WorkflowGraph } from "./graph.ts";
export type { WorkflowPromptSource } from "./prompt.ts";

export interface WorkflowCreateInput {
  projectId: string;
  name: string;
  nodes: WorkflowNodeDto[];
  edges: WorkflowEdgeDto[];
  defaults?: WorkflowRunOptionsDto;
}

export interface WorkflowUpdateInput {
  name?: string;
  nodes?: WorkflowNodeDto[];
  edges?: WorkflowEdgeDto[];
  defaults?: WorkflowRunOptionsDto;
}

export type WorkflowNodeUpdate = Partial<Omit<WorkflowRunNodeDto, "id" | "role">>;

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
}

export type RunNodeFn = (
  context: RunNodeContext,
  onUpdate: (patch: WorkflowNodeUpdate) => Promise<void>,
) => Promise<{ sessionId?: string; output: string }>;

export interface WorkflowDeps {
  file: string;
  append: (sessionId: string, type: string, data: JsonObject) => Promise<unknown>;
  runNode: RunNodeFn;
  now?: () => number;
}

export interface WorkflowService {
  list(projectId?: string): WorkflowDto[];
  get(id: string): WorkflowDto | null;
  create(input: WorkflowCreateInput): WorkflowDto;
  update(id: string, patch: WorkflowUpdateInput): WorkflowDto;
  remove(id: string): boolean;
  start(
    workflowId: string,
    sessionId: string,
    input: string,
    options?: WorkflowRunOptionsDto,
  ): Promise<WorkflowRunDto>;
  listRuns(projectId?: string): WorkflowRunDto[];
  getRun(runId: string): WorkflowRunDto | null;
  stop(runId: string): Promise<WorkflowRunDto>;
}

interface ActiveRun {
  parentSessionId: string;
  workflow: WorkflowDto;
  run: WorkflowRunDto;
  controller: AbortController;
  done: Promise<void>;
}

const DEFAULT_MAX_PARALLEL = 4;
const DEFAULT_NODE_TIMEOUT_MS = 30 * 60_000;

const workflowError = (message: string, code = "invalid-input"): Error =>
  Object.assign(new Error(message), { code });

const cloneWorkflow = (workflow: WorkflowDto): WorkflowDto =>
  structuredClone(workflow);

const cloneRun = (run: WorkflowRunDto): WorkflowRunDto =>
  structuredClone(run);

const jsonData = (value: unknown): JsonObject =>
  JSON.parse(JSON.stringify(value)) as JsonObject;

function validateOptions(options: WorkflowRunOptionsDto | undefined): void {
  if (!options) return;
  if (options.pipe !== undefined && options.pipe !== "direct" && options.pipe !== "ancestors") {
    throw workflowError("pipe must be direct or ancestors");
  }
  if (options.permissions !== undefined && options.permissions !== "auto" && options.permissions !== "manual") {
    throw workflowError("permissions must be auto or manual");
  }
  if (options.maxParallel !== undefined && (
    !Number.isInteger(options.maxParallel) || options.maxParallel < 1 || options.maxParallel > 32
  )) {
    throw workflowError("maxParallel must be a whole number from 1 to 32");
  }
  if (options.nodeTimeoutMs !== undefined && (
    !Number.isInteger(options.nodeTimeoutMs) || options.nodeTimeoutMs < 1_000
  )) {
    throw workflowError("nodeTimeoutMs must be a whole number >= 1000");
  }
}

function validateDefinition(input: WorkflowCreateInput): string[][] {
  if (!input.projectId.trim()) throw workflowError("projectId is required");
  if (!input.name.trim()) throw workflowError("workflow name is required");
  for (const node of input.nodes) {
    if (!node.role.trim()) throw workflowError(`role is required for node ${node.id || "(missing id)"}`);
    if (!node.prompt.trim()) throw workflowError(`prompt is required for node ${node.id || "(missing id)"}`);
  }
  const result = layerize(input);
  if (!result.ok) throw workflowError(result.error);
  validateOptions(input.defaults);
  return result.layers;
}

function normalizeOptions(
  defaults?: WorkflowRunOptionsDto,
  override?: WorkflowRunOptionsDto,
): Required<WorkflowRunOptionsDto> {
  validateOptions(defaults);
  validateOptions(override);
  const merged = { ...defaults, ...override };
  return {
    pipe: (merged.pipe ?? "ancestors") as WorkflowPipeMode,
    permissions: (merged.permissions ?? "auto") as WorkflowPermissionPolicy,
    maxParallel: Math.max(1, Math.min(32, Math.floor(merged.maxParallel ?? DEFAULT_MAX_PARALLEL))),
    nodeTimeoutMs: Math.max(1_000, Math.floor(merged.nodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS)),
  };
}

function load(file: string): WorkflowDto[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { workflows?: unknown };
    return Array.isArray(parsed.workflows) ? parsed.workflows as WorkflowDto[] : [];
  } catch {
    return [];
  }
}

export function createWorkflowService(deps: WorkflowDeps): WorkflowService {
  const now = deps.now ?? Date.now;
  let workflows = load(deps.file);
  const runs = new Map<string, ActiveRun>();

  const save = (): void => {
    mkdirSync(dirname(deps.file), { recursive: true });
    const temporary = `${deps.file}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify({ v: 1, workflows }, null, 2)}\n`, "utf8");
    renameSync(temporary, deps.file);
  };

  const mustGet = (id: string): WorkflowDto => {
    const workflow = workflows.find((candidate) => candidate.id === id);
    if (!workflow) throw workflowError("workflow not found", "not-found");
    return workflow;
  };

  const patchNode = async (
    active: ActiveRun,
    nodeId: string,
    patch: WorkflowNodeUpdate,
  ): Promise<void> => {
    const current = active.run.nodes.find((node) => node.id === nodeId);
    if (!current) return;
    const next = { ...current, ...patch };
    await deps.append(active.parentSessionId, "workflow/node-progress", jsonData({
      runId: active.run.id,
      nodeId,
      node: next,
    }));
    Object.assign(current, patch);
  };

  const executeNode = async (
    active: ActiveRun,
    node: WorkflowNodeDto,
    options: Required<WorkflowRunOptionsDto>,
    layerOrder: Map<string, number>,
  ): Promise<void> => {
    const direct = upstream(active.workflow, node.id);
    const blocked = direct.some((id) => {
      const status = active.run.nodes.find((entry) => entry.id === id)?.status;
      return status === "error" || status === "skipped" || status === "stopped";
    });
    if (blocked) {
      await patchNode(active, node.id, {
        status: "skipped",
        error: "upstream failed",
        finishedAt: now(),
      });
      return;
    }
    if (active.controller.signal.aborted) return;

    const sourceIds = options.pipe === "direct"
      ? direct
      : [...ancestors(active.workflow, node.id)].sort(
          (a, b) => (layerOrder.get(a) ?? 0) - (layerOrder.get(b) ?? 0) || a.localeCompare(b),
        );
    const sources = sourceIds.flatMap((id) => {
      const sourceNode = active.workflow.nodes.find((candidate) => candidate.id === id);
      const sourceRun = active.run.nodes.find((candidate) => candidate.id === id);
      return sourceNode && sourceRun?.output !== undefined
        ? [{ node: sourceNode, output: sourceRun.output }]
        : [];
    });
    const prompt = buildNodePrompt(node, active.run.input, sources);
    await patchNode(active, node.id, {
      status: "running",
      startedAt: now(),
      activity: "starting session",
      prompt,
    });

    try {
      const result = await deps.runNode({
        parentSessionId: active.parentSessionId,
        runId: active.run.id,
        workflowId: active.workflow.id,
        projectId: active.workflow.projectId,
        node,
        prompt,
        permissions: options.permissions,
        timeoutMs: options.nodeTimeoutMs,
        signal: active.controller.signal,
      }, (patch) => patchNode(active, node.id, patch));
      if (active.controller.signal.aborted) {
        await patchNode(active, node.id, {
          status: "stopped",
          activity: undefined,
          finishedAt: now(),
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        });
      } else {
        await patchNode(active, node.id, {
          status: "done",
          output: result.output,
          activity: undefined,
          finishedAt: now(),
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        });
      }
    } catch (cause) {
      const stopped = active.controller.signal.aborted || (cause as { name?: string })?.name === "AbortError";
      await patchNode(active, node.id, stopped
        ? { status: "stopped", activity: undefined, finishedAt: now() }
        : {
            status: "error",
            activity: undefined,
            error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 500),
            finishedAt: now(),
          });
    }
  };

  const execute = async (
    active: ActiveRun,
    options: Required<WorkflowRunOptionsDto>,
  ): Promise<void> => {
    const layerOrder = new Map(
      active.run.layers.flatMap((ids, index) => ids.map((id) => [id, index] as const)),
    );
    for (const layer of active.run.layers) {
      if (active.controller.signal.aborted) break;
      await pool(layer, options.maxParallel, active.controller.signal, async (id) => {
        const node = active.workflow.nodes.find((candidate) => candidate.id === id);
        if (node) await executeNode(active, node, options, layerOrder);
      });
    }

    for (const node of active.run.nodes) {
      if (node.status === "queued" || node.status === "running") {
        await patchNode(active, node.id, {
          status: "stopped",
          activity: undefined,
          finishedAt: now(),
        });
      }
    }

    const status: WorkflowRunStatus = active.controller.signal.aborted
      ? "stopped"
      : active.run.nodes.some((node) => node.status === "error")
        ? "error"
        : "done";
    const finishedAt = now();
    await deps.append(active.parentSessionId, "workflow/run-completed", jsonData({
      runId: active.run.id,
      status,
      finishedAt,
    }));
    active.run.status = status;
    active.run.finishedAt = finishedAt;
  };

  return {
    list(projectId) {
      return workflows
        .filter((workflow) => !projectId || workflow.projectId === projectId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(cloneWorkflow);
    },

    get(id) {
      const workflow = workflows.find((candidate) => candidate.id === id);
      return workflow ? cloneWorkflow(workflow) : null;
    },

    create(input) {
      validateDefinition(input);
      const timestamp = now();
      const workflow: WorkflowDto = {
        id: randomUUID(),
        projectId: input.projectId.trim(),
        name: input.name.trim(),
        nodes: structuredClone(input.nodes),
        edges: structuredClone(input.edges),
        ...(input.defaults ? { defaults: structuredClone(input.defaults) } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      workflows.push(workflow);
      save();
      return cloneWorkflow(workflow);
    },

    update(id, patch) {
      const current = mustGet(id);
      const candidate: WorkflowCreateInput = {
        projectId: current.projectId,
        name: patch.name ?? current.name,
        nodes: patch.nodes ?? current.nodes,
        edges: patch.edges ?? current.edges,
        defaults: patch.defaults ?? current.defaults,
      };
      validateDefinition(candidate);
      current.name = candidate.name.trim();
      current.nodes = structuredClone(candidate.nodes);
      current.edges = structuredClone(candidate.edges);
      if (candidate.defaults) current.defaults = structuredClone(candidate.defaults);
      current.updatedAt = now();
      save();
      return cloneWorkflow(current);
    },

    remove(id) {
      const before = workflows.length;
      workflows = workflows.filter((workflow) => workflow.id !== id);
      if (workflows.length !== before) save();
      return workflows.length !== before;
    },

    async start(workflowId, sessionId, input, override) {
      const workflow = cloneWorkflow(mustGet(workflowId));
      if (!sessionId.trim()) throw workflowError("sessionId is required");
      if (!input.trim()) throw workflowError("workflow input is required");
      const validation = layerize(workflow);
      if (!validation.ok) throw workflowError(validation.error);
      const options = normalizeOptions(workflow.defaults, override);
      const run: WorkflowRunDto = {
        id: randomUUID(),
        workflowId: workflow.id,
        projectId: workflow.projectId,
        parentSessionId: sessionId.trim(),
        name: workflow.name,
        input: input.trim(),
        options,
        status: "running",
        startedAt: now(),
        layers: validation.layers,
        nodes: workflow.nodes.map((node) => ({
          id: node.id,
          role: node.role,
          status: "queued",
          ...(node.model ? { model: node.model } : {}),
          ...(node.agent ? { agent: node.agent } : {}),
        })),
      };
      await deps.append(sessionId, "workflow/run-started", jsonData({
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
      }));

      const controller = new AbortController();
      const active = {
        parentSessionId: sessionId,
        workflow,
        run,
        controller,
        done: Promise.resolve(),
      } satisfies ActiveRun;
      runs.set(run.id, active);
      active.done = execute(active, options).catch(async (cause) => {
        if (active.run.status !== "running") return;
        const finishedAt = now();
        await deps.append(sessionId, "workflow/run-completed", jsonData({
          runId: run.id,
          status: "error",
          finishedAt,
          error: cause instanceof Error ? cause.message : String(cause),
        })).catch(() => {});
        active.run.status = "error";
        active.run.finishedAt = finishedAt;
      });
      return cloneRun(run);
    },

    listRuns(projectId) {
      return [...runs.values()]
        .map((active) => active.run)
        .filter((run) => !projectId || run.projectId === projectId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(cloneRun);
    },

    getRun(runId) {
      const active = runs.get(runId);
      return active ? cloneRun(active.run) : null;
    },

    async stop(runId) {
      const active = runs.get(runId);
      if (!active) throw workflowError("workflow run not found", "not-found");
      if (active.run.status === "running") active.controller.abort();
      await active.done;
      return cloneRun(active.run);
    },
  };
}

async function pool<T>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0 && !signal.aborted) {
      await work(queue.shift()!);
    }
  });
  await Promise.all(workers);
}
