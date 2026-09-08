// Canonical capability contribution registry and pure provisioning planner.
// Harness providers own projection; this module never writes vendor config.
import { createHash } from "node:crypto";
import type {
  AgentCapabilityContribution,
  AgentCapabilityContributionRegistry,
  AgentCapabilityDescriptor,
  AgentCapabilityKind,
  CapabilityMutability,
  CapabilityProjectionMode,
  Disposable,
  HarnessCapabilityApplicationReceipt,
  HarnessCapabilitySupport,
  HarnessContext,
  HarnessProvisioningPlan,
  HarnessProvisioningTarget,
  JsonObject,
  ToolExecutor,
} from "@polyth/contracts";

const harnessError = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const ID_RE = /^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9./_-]*$/;
const POLYTH_OWNER = /^polyth(?:\.|$)/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SKILL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_MCP_NAME = "polyth-agent-tools";
const MAX_INSTRUCTION = 64 * 1024;
const MAX_DESCRIPTION = 4096;
const KINDS: readonly AgentCapabilityKind[] = [
  "instruction", "mcp-server", "tool", "skill", "context", "extension",
];

export const capabilityRevision = (...parts: string[]): string =>
  createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 16);

export const desiredBundleRevision = (descriptors: readonly AgentCapabilityDescriptor[]): string =>
  capabilityRevision(...descriptors.map((item) => `${item.id}:${item.revision}`).sort());

/** Hash every semantic field that affects projection. Package `revision` is an
 * input, not the sole authority — a schema change without a bump still rotates. */
export const semanticCapabilityRevision = (descriptor: AgentCapabilityDescriptor): string => {
  const base = [
    descriptor.id,
    descriptor.kind,
    descriptor.owner,
    descriptor.scope,
    descriptor.revision,
    descriptor.spaceId ?? "",
    descriptor.projectId ?? "",
  ];
  if (descriptor.kind === "instruction") {
    return capabilityRevision(...base, descriptor.title ?? "", descriptor.text);
  }
  if (descriptor.kind === "mcp-server") {
    return capabilityRevision(
      ...base,
      descriptor.name,
      String(descriptor.enabled),
      JSON.stringify(descriptor.transport),
      JSON.stringify(descriptor.raw ?? {}),
    );
  }
  if (descriptor.kind === "tool") {
    return capabilityRevision(
      ...base,
      descriptor.name,
      descriptor.description,
      JSON.stringify(descriptor.inputSchema),
      descriptor.trust,
      String(descriptor.mutating),
    );
  }
  if (descriptor.kind === "skill") {
    return capabilityRevision(...base, descriptor.name, descriptor.title, descriptor.description, descriptor.instructions);
  }
  if (descriptor.kind === "context") {
    return capabilityRevision(...base, descriptor.title, descriptor.text);
  }
  return capabilityRevision(...base, descriptor.namespace, descriptor.schemaVersion, JSON.stringify(descriptor.value));
};

const matchesScope = (descriptor: AgentCapabilityDescriptor, context: HarnessContext): boolean => {
  if (descriptor.spaceId && descriptor.spaceId !== context.spaceId) return false;
  if (descriptor.projectId && descriptor.projectId !== context.projectId) return false;
  if (descriptor.scope === "session" && !context.sessionId) return false;
  if (descriptor.scope === "project" && !context.projectId) return false;
  return true;
};

const assertJsonSchemaObject = (schema: JsonObject, id: string): void => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw harnessError("invalid-input", `tool ${id} inputSchema must be a JSON object`);
  }
  const type = schema.type;
  if (type !== undefined && type !== "object") {
    throw harnessError("invalid-input", `tool ${id} inputSchema.type must be "object"`);
  }
};

const validateContribution = (descriptor: AgentCapabilityDescriptor, execute?: ToolExecutor): void => {
  if (descriptor.kind === "instruction") {
    if (typeof descriptor.text !== "string" || descriptor.text.length > MAX_INSTRUCTION) {
      throw harnessError("invalid-input", `instruction ${descriptor.id} exceeds ${MAX_INSTRUCTION} characters`);
    }
  }
  if (descriptor.kind === "tool") {
    if (typeof execute !== "function") {
      throw harnessError("invalid-input", `tool ${descriptor.id} requires an execute handler`);
    }
    if (!TOOL_NAME_RE.test(descriptor.name)) {
      throw harnessError("invalid-input", `tool ${descriptor.id} has an invalid name`);
    }
    if (typeof descriptor.description !== "string" || descriptor.description.length > MAX_DESCRIPTION) {
      throw harnessError("invalid-input", `tool ${descriptor.id} description is missing or too long`);
    }
    assertJsonSchemaObject(descriptor.inputSchema, descriptor.id);
    if (descriptor.trust === "pure" && descriptor.mutating) {
      throw harnessError("invalid-input", `tool ${descriptor.id} cannot be both pure and mutating`);
    }
  }
  if (descriptor.kind === "skill") {
    if (!SKILL_ID_RE.test(descriptor.name) || descriptor.name.length > 64) {
      throw harnessError("invalid-input", `skill ${descriptor.id} has an invalid name`);
    }
    if (typeof descriptor.instructions !== "string" || descriptor.instructions.length > MAX_INSTRUCTION) {
      throw harnessError("invalid-input", `skill ${descriptor.id} instructions exceed ${MAX_INSTRUCTION} characters`);
    }
    if (typeof descriptor.description !== "string" || descriptor.description.length > MAX_DESCRIPTION) {
      throw harnessError("invalid-input", `skill ${descriptor.id} description is missing or too long`);
    }
  }
  if (descriptor.kind === "mcp-server") {
    if (!descriptor.name || descriptor.name.length > 64) {
      throw harnessError("invalid-input", `mcp-server ${descriptor.id} needs a name (≤64 chars)`);
    }
    if (descriptor.name === RESERVED_MCP_NAME) {
      throw harnessError("invalid-input", `mcp-server name ${RESERVED_MCP_NAME} is reserved`);
    }
  }
};

export function createCapabilityContributionRegistry(): AgentCapabilityContributionRegistry {
  const items = new Map<string, AgentCapabilityContribution>();
  return {
    register(owner, contribution) {
      const descriptor = contribution.descriptor;
      if (POLYTH_OWNER.test(owner) || descriptor.id.startsWith("polyth.")) {
        throw harnessError("invalid-input", "polyth.* capability ids are reserved for the server");
      }
      if (!ID_RE.test(descriptor.id)) {
        throw harnessError("invalid-input", `invalid capability id ${descriptor.id}`);
      }
      if (!descriptor.id.startsWith(`${owner}.`)) {
        throw harnessError("invalid-input", `capability ${descriptor.id} must be namespaced by owner ${owner}`);
      }
      if (descriptor.owner !== owner) {
        throw harnessError("invalid-input", "capability owner must match the registering package");
      }
      if (!KINDS.includes(descriptor.kind)) {
        throw harnessError("invalid-input", `unknown capability kind ${(descriptor as { kind: string }).kind}`);
      }
      if (items.has(descriptor.id)) {
        throw harnessError("conflict", `capability already registered: ${descriptor.id}`);
      }
      validateContribution(descriptor, contribution.execute);
      const stored: AgentCapabilityContribution = {
        ...contribution,
        descriptor: { ...descriptor, revision: semanticCapabilityRevision(descriptor) },
      };
      items.set(descriptor.id, stored);
      return {
        dispose() {
          if (items.get(descriptor.id) === stored) items.delete(descriptor.id);
        },
      } satisfies Disposable;
    },
    list: () => [...items.values()].sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id)),
    resolve(context) {
      return [...items.values()]
        .map((item) => item.descriptor)
        .filter((descriptor) => matchesScope(descriptor, context))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    executor(capabilityId): ToolExecutor | undefined {
      return items.get(capabilityId)?.execute;
    },
    contribution(capabilityId): AgentCapabilityContribution | undefined {
      return items.get(capabilityId);
    },
  };
}

const SCOPE_WIDTH: Record<AgentCapabilityDescriptor["scope"], number> = {
  session: 0,
  project: 1,
  space: 2,
  deployment: 3,
};

const firstSupportedMode = (
  support: HarnessCapabilitySupport,
  capability: AgentCapabilityDescriptor,
  remote: boolean,
): { mode: CapabilityProjectionMode; mutability: CapabilityMutability } => {
  const entry = support.kinds[capability.kind];
  if (!entry || entry.modes.length === 0) {
    return { mode: "unsupported", mutability: "immutable" };
  }
  if (remote && entry.remote === false) {
    return { mode: "unsupported", mutability: "immutable" };
  }
  if (entry.configScope && SCOPE_WIDTH[capability.scope] < SCOPE_WIDTH[entry.configScope]) {
    return { mode: "unsupported", mutability: "immutable" };
  }
  const mode = entry.modes.find((item) => item !== "unsupported") ?? "unsupported";
  return { mode, mutability: entry.mutability };
};

/** Pure planner: desired descriptors + harness support → provisioning plan. */
export function planHarnessCapabilities(
  harnessId: string,
  desired: readonly AgentCapabilityDescriptor[],
  support: HarnessCapabilitySupport,
  context: Pick<HarnessContext, "remote">,
): HarnessProvisioningPlan {
  const desiredRevision = desiredBundleRevision(desired);
  const items = desired.map((capability) => {
    const resolved = firstSupportedMode(support, capability, Boolean(context.remote));
    return {
      capability,
      mode: resolved.mode,
      mutability: resolved.mutability,
    };
  });
  const projectedNames = new Map<string, string[]>();
  for (const item of items) {
    if (item.capability.kind !== "mcp-server" || item.mode === "unsupported") continue;
    const ids = projectedNames.get(item.capability.name) ?? [];
    ids.push(item.capability.id);
    projectedNames.set(item.capability.name, ids);
  }
  return {
    harnessId,
    desiredRevision,
    items: items.map((item) => {
      if (item.capability.kind !== "mcp-server" || item.mode === "unsupported") return item;
      if (item.capability.name === RESERVED_MCP_NAME && item.capability.id !== "polyth.agent-tools") {
        return { ...item, mode: "unsupported" as const, mutability: "immutable" as const };
      }
      const claimants = projectedNames.get(item.capability.name) ?? [];
      if (claimants.length > 1) {
        return { ...item, mode: "unsupported" as const, mutability: "immutable" as const };
      }
      return item;
    }),
  };
}

export const mcpNativeNameCollision = (
  items: HarnessProvisioningPlan["items"],
  capabilityId: string,
): string | undefined => {
  const item = items.find((row) => row.capability.id === capabilityId);
  if (!item || item.capability.kind !== "mcp-server") return undefined;
  const nativeName = item.capability.name;
  if (nativeName === RESERVED_MCP_NAME && item.capability.id !== "polyth.agent-tools") {
    return `Native MCP name ${RESERVED_MCP_NAME} is reserved`;
  }
  const claimants = items.filter((row) =>
    row.capability.kind === "mcp-server" && row.capability.name === nativeName);
  if (claimants.length > 1) {
    return `Native MCP name "${nativeName}" is claimed by ${claimants.map((row) => row.capability.id).join(", ")}`;
  }
  return undefined;
};

export function overlayKey(context: HarnessContext, harnessId = ""): string {
  return JSON.stringify([context.spaceId, context.projectId, context.cwd, context.sessionId ?? "", harnessId]);
}

export function provisioningTarget(
  context: HarnessContext,
  harnessId: string,
  extra?: Pick<HarnessProvisioningTarget, "authorityId" | "generation">,
): HarnessProvisioningTarget {
  return {
    spaceId: context.spaceId,
    projectId: context.projectId,
    cwd: context.cwd,
    harnessId,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(extra?.authorityId ? { authorityId: extra.authorityId } : {}),
    ...(extra?.generation !== undefined ? { generation: extra.generation } : {}),
  };
}

export function provisioningTargetKey(target: HarnessProvisioningTarget): string {
  return JSON.stringify([
    target.spaceId,
    target.projectId,
    target.cwd,
    target.harnessId,
    target.sessionId ?? "",
    target.authorityId ?? "",
    target.generation ?? 0,
  ]);
}

export interface LaunchOverlayRecord<T> {
  value: T;
  desiredRevision: string;
  capabilityIds: string[];
}

export interface LaunchOverlayStore<T> {
  set(context: HarnessContext, value: T, harnessId?: string, meta?: { desiredRevision?: string; capabilityIds?: string[] }): void;
  peek(context: HarnessContext, harnessId?: string): LaunchOverlayRecord<T> | undefined;
  get(context: HarnessContext, harnessId?: string): T | undefined;
  consume(context: HarnessContext, harnessId?: string): LaunchOverlayRecord<T> | undefined;
  consumeIfRevision(
    context: HarnessContext,
    harnessId: string | undefined,
    expectedDesiredRevision: string,
  ): LaunchOverlayRecord<T> | undefined;
  delete(context: HarnessContext, harnessId?: string): void;
  release(context: HarnessContext): void;
}

export function createLaunchOverlayStore<T>(): LaunchOverlayStore<T> {
  const map = new Map<string, LaunchOverlayRecord<T>>();
  const keyOf = (context: HarnessContext, harnessId = "") => overlayKey(context, harnessId);
  return {
    set(context: HarnessContext, value: T, harnessId = "", meta?: { desiredRevision?: string; capabilityIds?: string[] }): void {
      map.set(keyOf(context, harnessId), {
        value,
        desiredRevision: meta?.desiredRevision ?? "",
        capabilityIds: meta?.capabilityIds ?? [],
      });
    },
    peek(context: HarnessContext, harnessId = ""): LaunchOverlayRecord<T> | undefined {
      return map.get(keyOf(context, harnessId));
    },
    /** Compatibility: read without consuming. Native create must peek, then
     * consume only after the native request is accepted. */
    get(context: HarnessContext, harnessId = ""): T | undefined {
      return map.get(keyOf(context, harnessId))?.value;
    },
    consume(context: HarnessContext, harnessId = ""): LaunchOverlayRecord<T> | undefined {
      const key = keyOf(context, harnessId);
      const record = map.get(key);
      if (record) map.delete(key);
      return record;
    },
    consumeIfRevision(
      context: HarnessContext,
      harnessId = "",
      expectedDesiredRevision: string,
    ): LaunchOverlayRecord<T> | undefined {
      const key = keyOf(context, harnessId);
      const record = map.get(key);
      if (record?.desiredRevision !== expectedDesiredRevision) return undefined;
      map.delete(key);
      return record;
    },
    delete(context: HarnessContext, harnessId = ""): void {
      map.delete(keyOf(context, harnessId));
    },
    release(context: HarnessContext): void {
      for (const key of [...map.keys()]) {
        try {
          const parsed = JSON.parse(key) as unknown[];
          if (
            parsed[0] === context.spaceId
            && parsed[1] === context.projectId
            && parsed[2] === context.cwd
            && parsed[3] === (context.sessionId ?? "")
          ) {
            map.delete(key);
          }
        } catch {
          map.delete(key);
        }
      }
    },
  };
}

const receiptSinks = new Set<(receipt: HarnessCapabilityApplicationReceipt) => void>();

export function setCapabilityReceiptSink(handler?: (receipt: HarnessCapabilityApplicationReceipt) => void): () => void {
  if (!handler) return () => {};
  receiptSinks.add(handler);
  return () => { receiptSinks.delete(handler); };
}

export function acknowledgeCapabilityApplication(receipt: HarnessCapabilityApplicationReceipt): void {
  for (const sink of receiptSinks) sink(receipt);
}

/** Overlay was read for a native create/spawn (in-flight) or that spawn failed. */
export interface CapabilityLaunchCapture {
  target: Pick<HarnessProvisioningTarget, "spaceId" | "projectId" | "cwd" | "harnessId" | "sessionId">;
  desiredRevision: string;
  outcome: "captured" | "failed";
}

const launchSinks = new Set<(event: CapabilityLaunchCapture) => void>();

export function setCapabilityLaunchSink(handler?: (event: CapabilityLaunchCapture) => void): () => void {
  if (!handler) return () => {};
  launchSinks.add(handler);
  return () => { launchSinks.delete(handler); };
}

export function captureCapabilityLaunch(event: Omit<CapabilityLaunchCapture, "outcome"> & { outcome?: "captured" }): void {
  const payload: CapabilityLaunchCapture = { ...event, outcome: "captured" };
  for (const sink of launchSinks) sink(payload);
}

export function releaseCapabilityLaunch(event: Omit<CapabilityLaunchCapture, "outcome"> & { outcome?: "failed" }): void {
  const payload: CapabilityLaunchCapture = { ...event, outcome: "failed" };
  for (const sink of launchSinks) sink(payload);
}
