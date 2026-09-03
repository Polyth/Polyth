import { join } from "node:path";
import type {
  ModelRef,
  RouteHandler,
  WorkflowEdgeDto,
  WorkflowNodeDto,
  WorkflowRunOptionsDto,
} from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  createWorkflowService,
  type WorkflowCreateInput,
  type WorkflowService,
  type WorkflowUpdateInput,
} from "./index.ts";
import { createWorkflowRunNode } from "./runner.ts";

const asModel = (value: unknown): ModelRef | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const model = value as { providerID?: unknown; modelID?: unknown; variant?: unknown };
  return typeof model.providerID === "string" && typeof model.modelID === "string"
    ? {
        providerID: model.providerID,
        modelID: model.modelID,
        ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
      }
    : undefined;
};

const optionsOf = (value: unknown): WorkflowRunOptionsDto | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    ...(raw.pipe === "direct" || raw.pipe === "ancestors" ? { pipe: raw.pipe } : {}),
    ...(raw.permissions === "auto" || raw.permissions === "manual"
      ? { permissions: raw.permissions }
      : {}),
    ...(raw.maxParallel !== undefined ? { maxParallel: Number(raw.maxParallel) } : {}),
    ...(raw.nodeTimeoutMs !== undefined ? { nodeTimeoutMs: Number(raw.nodeTimeoutMs) } : {}),
  };
};

const nodesOf = (value: unknown): WorkflowNodeDto[] => Array.isArray(value)
  ? value.map((candidate) => {
      const raw = candidate && typeof candidate === "object"
        ? candidate as Record<string, unknown>
        : {};
      const model = asModel(raw.model);
      const position = raw.position && typeof raw.position === "object"
        ? raw.position as Record<string, unknown>
        : undefined;
      return {
        id: String(raw.id ?? ""),
        role: String(raw.role ?? ""),
        prompt: String(raw.prompt ?? ""),
        ...(model ? { model } : {}),
        ...(typeof raw.agent === "string" && raw.agent ? { agent: raw.agent } : {}),
        ...(position && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.y))
          ? { position: { x: Number(position.x), y: Number(position.y) } }
          : {}),
      };
    })
  : [];

const edgesOf = (value: unknown): WorkflowEdgeDto[] => Array.isArray(value)
  ? value.map((candidate) => {
      const raw = candidate && typeof candidate === "object"
        ? candidate as Record<string, unknown>
        : {};
      return {
        id: String(raw.id ?? ""),
        source: String(raw.source ?? ""),
        target: String(raw.target ?? ""),
      };
    })
  : [];

export function workflowRoutes(workflow: WorkflowService): RouteHandler {
  return async ({ path, method, url, body, json }) => {
    if (path === "/api/workflows" && method === "GET") {
      json(200, workflow.list(url.searchParams.get("projectId") ?? undefined));
      return true;
    }
    if (path === "/api/workflows" && method === "POST") {
      const raw = await body();
      const input: WorkflowCreateInput = {
        projectId: String(raw.projectId ?? ""),
        name: String(raw.name ?? ""),
        nodes: nodesOf(raw.nodes),
        edges: edgesOf(raw.edges),
        ...(optionsOf(raw.defaults) ? { defaults: optionsOf(raw.defaults)! } : {}),
      };
      json(200, workflow.create(input));
      return true;
    }
    if (path === "/api/workflow-runs" && method === "GET") {
      json(200, workflow.listRuns(url.searchParams.get("projectId") ?? undefined));
      return true;
    }

    let match = path.match(/^\/api\/workflow-runs\/([^/]+)(?:\/(stop))?$/);
    if (match) {
      const runId = decodeURIComponent(match[1]!);
      if (method === "GET" && !match[2]) {
        const run = workflow.getRun(runId);
        if (!run) {
          json(404, { error: "not-found", message: "workflow run not found" });
          return true;
        }
        json(200, run);
        return true;
      }
      if (method === "POST" && match[2] === "stop") {
        json(200, await workflow.stop(runId));
        return true;
      }
      return false;
    }

    match = path.match(/^\/api\/workflows\/([^/]+)(?:\/(run))?$/);
    if (!match) return false;
    const id = decodeURIComponent(match[1]!);
    if (method === "POST" && match[2] === "run") {
      const raw = await body();
      json(200, await workflow.start(
        id,
        String(raw.sessionId ?? ""),
        String(raw.input ?? ""),
        optionsOf(raw.options),
      ));
      return true;
    }
    if (match[2]) return false;
    if (method === "GET") {
      const found = workflow.get(id);
      if (!found) {
        json(404, { error: "not-found", message: "workflow not found" });
        return true;
      }
      json(200, found);
      return true;
    }
    if (method === "PATCH") {
      const raw = await body();
      const patch: WorkflowUpdateInput = {
        ...(raw.name !== undefined ? { name: String(raw.name) } : {}),
        ...(raw.nodes !== undefined ? { nodes: nodesOf(raw.nodes) } : {}),
        ...(raw.edges !== undefined ? { edges: edgesOf(raw.edges) } : {}),
        ...(raw.defaults !== undefined ? { defaults: optionsOf(raw.defaults) ?? {} } : {}),
      };
      json(200, workflow.update(id, patch));
      return true;
    }
    if (method === "DELETE") {
      if (!workflow.remove(id)) {
        json(404, { error: "not-found", message: "workflow not found" });
        return true;
      }
      json(200, { ok: true });
      return true;
    }
    return false;
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  // Every workflow node runs through the canonical session service, so nodes
  // stay visible, permission-aware, abortable, and durably logged.
  const workflow = createWorkflowService({
    file: join(host.storageDir, "workflows.json"),
    append: (sessionId, type, data) =>
      host.events.append(sessionId, type, data, {
        ignorable: true,
        producerPlugin: "workflow",
      }),
    runNode: createWorkflowRunNode(host.sessions),
  });
  host.services.provide(serverServiceKey<WorkflowService>("workflow"), workflow);
  return {
    remoteAccess: localOnlyRemoteAccess(["workflow"]),
    routes: workflowRoutes(workflow),
  };
}
