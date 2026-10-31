// `polyth_session_markers` agent tool and its skill: how an agent finds the
// chats a person marked ("review every chat that needs it") and marks chats
// itself. Server-only; it acts with the turn's person's view of the Space.
import type { AgentCapabilityContribution, JsonObject, SpaceContext, ToolExecutionContext } from "@polyth/contracts";
import {
  BUILT_IN_MARKERS,
  MARKER_NOTE_MAX,
  invalidInput,
  resolveMarker,
  SESSION_MARKERS_PACKAGE_ID,
  type MarkerDefinition,
} from "./markers.ts";
import type { MarkedSession, MarkersSnapshot, SessionMarkersService } from "./service.ts";

export const SESSION_MARKERS_TOOL_ID = "session-markers.tool";
export const SESSION_MARKERS_SKILL_ID = "session-markers.skill";
export const SESSION_MARKERS_TOOL_NAME = "polyth_session_markers";

export interface SessionMarkersToolDeps {
  service: SessionMarkersService;
  /** The person's context in the Space, or undefined (no such member). */
  personSpace(userId: string, spaceId: string): SpaceContext | undefined;
  /** Context for a turn with no acting person; limited to the calling chat. */
  systemSpace(spaceId: string): SpaceContext;
  projectName?(space: SpaceContext, projectId: string): Promise<string | undefined>;
}

const ACTIONS = ["list", "markers", "get", "add", "remove"] as const;
type Action = typeof ACTIONS[number];

const builtInSummary = BUILT_IN_MARKERS.map((marker) => `\`${marker.id}\` (${marker.label})`).join(", ");

const inputSchema: JsonObject = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: [...ACTIONS],
      description: "list: chats that carry a marker (all markers when `marker` is omitted). markers: every marker defined in this Space. get: the markers of one chat. add / remove: put a marker on or take it off chats.",
    },
    marker: {
      type: "string",
      description: `Marker id or name, e.g. ${builtInSummary} or a custom one. add creates a custom marker the first time a new name is used.`,
    },
    sessionId: { type: "string", description: "Chat (session) id for get/add/remove. Defaults to this chat." },
    sessionIds: { type: "array", items: { type: "string" }, description: "Several chat ids for add/remove." },
    note: { type: "string", description: `Optional short reason shown with the marker (add only, up to ${MARKER_NOTE_MAX} characters).` },
    projectId: { type: "string", description: "list: only chats of this project." },
    includeArchived: { type: "boolean", description: "list: include archived chats (default false)." },
  },
};

export const sessionMarkersSkill: AgentCapabilityContribution = {
  descriptor: {
    id: SESSION_MARKERS_SKILL_ID,
    kind: "skill",
    owner: SESSION_MARKERS_PACKAGE_ID,
    scope: "deployment",
    revision: "1",
    name: "polyth-session-markers",
    title: "Polyth chat markers",
    description: "Find or set the markers on Polyth chats (sessions): needs review, reply later, important and custom ones.",
    instructions: `People mark Polyth chats (sessions) to sort their work. Predefined markers: ${builtInSummary}. A Space may add custom markers; list them with action "markers".
When the user refers to chats by such a status (for example "review the code of every session that needs it", "what did I want to reply to later", "go through my important chats"), call ${SESSION_MARKERS_TOOL_NAME} with action "list" and that marker first. Its answer is the authoritative set; never guess from titles or recent activity. Read each listed chat with the Polyth control tool (session.get / session.messages) by its session id, or delegate per chat.
Markers are addressed by id or name ("needs review" finds needs-review). Use add/remove only when the user asks for it, or when the user's instructions say to mark finished work (for example add needs-review with a one-line note to your own chat). Do not remove a marker just because you looked at a chat; remove it when the user says the job behind it is done or asks you to.`,
  },
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const actorLabel = (session: MarkedSession["markers"][number]["by"], self: string): string => {
  if (session.kind === "agent") return session.sessionId === self ? "this chat's agent" : `the agent of ${session.sessionId}`;
  return "a person";
};

const date = (at: number): string => at > 0 ? new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "unknown time";

export function createSessionMarkersTool(deps: SessionMarkersToolDeps): AgentCapabilityContribution {
  const scope = (ctx: ToolExecutionContext): { space: SpaceContext; only?: string } => {
    if (!ctx.spaceId || !ctx.sessionId) throw new Error(`${SESSION_MARKERS_TOOL_NAME} needs a Polyth chat`);
    if (ctx.actorUserId) {
      const space = deps.personSpace(ctx.actorUserId, ctx.spaceId);
      if (!space) throw Object.assign(new Error("The person of this chat is not a member of its Space"), { code: "forbidden" });
      return { space };
    }
    // System work borrows nobody's view: it may see and mark only its own chat.
    return { space: deps.systemSpace(ctx.spaceId), only: ctx.sessionId };
  };

  const describe = async (space: SpaceContext, session: MarkedSession, definitions: readonly MarkerDefinition[], self: string, names: Map<string, string | undefined>): Promise<string> => {
    if (!names.has(session.projectId)) names.set(session.projectId, await deps.projectName?.(space, session.projectId).catch(() => undefined));
    const project = names.get(session.projectId);
    const head = `- ${session.sessionId} · “${session.title || "Untitled"}” · project ${project ? `${project} (${session.projectId})` : session.projectId}${session.archived ? " · archived" : ""}${session.sessionId === self ? " · this chat" : ""}`;
    const lines = session.markers.map((marker) => {
      const label = definitions.find((definition) => definition.id === marker.id)?.label ?? marker.id;
      return `    ${marker.id} (${label}) — marked ${date(marker.at)} by ${actorLabel(marker.by, self)}${marker.note ? ` — note: ${marker.note}` : ""}`;
    });
    return [head, ...lines].join("\n");
  };

  const listing = async (space: SpaceContext, snapshot: MarkersSnapshot, input: JsonObject, self: string, only?: string): Promise<string> => {
    const reference = text(input.marker);
    const marker = reference ? resolveMarker(snapshot.definitions, reference) : undefined;
    if (reference && !marker) {
      return `No marker named “${reference}”. Markers in this Space: ${snapshot.definitions.map((definition) => `${definition.id} (${definition.label})`).join(", ")}.`;
    }
    const projectId = text(input.projectId);
    const sessions = snapshot.sessions.filter((session) =>
      (!only || session.sessionId === only)
      && (!marker || session.markers.some((entry) => entry.id === marker.id))
      && (!projectId || session.projectId === projectId)
      && (input.includeArchived === true || !session.archived));
    const what = marker ? `marked “${marker.label}” (${marker.id})` : "with markers";
    if (sessions.length === 0) return `No chats ${what}${projectId ? ` in project ${projectId}` : ""}.`;
    const names = new Map<string, string | undefined>();
    const rows: string[] = [];
    for (const session of sessions) rows.push(await describe(space, session, snapshot.definitions, self, names));
    return [`${sessions.length} chat${sessions.length === 1 ? "" : "s"} ${what}:`, ...rows].join("\n");
  };

  const run = async (input: JsonObject, ctx: ToolExecutionContext): Promise<{ output: string; metadata?: JsonObject }> => {
    const action = input.action as Action;
    if (!ACTIONS.includes(action)) throw invalidInput(`action must be one of ${ACTIONS.join(", ")}`);
    const { space, only } = scope(ctx);
    const self = ctx.sessionId;
    if (action === "markers") {
      const snapshot = await deps.service.snapshot(space);
      return {
        output: ["Markers in this Space:", ...snapshot.definitions.map((marker) =>
          `- ${marker.id} (${marker.label})${marker.builtIn ? " · predefined" : " · custom"}${marker.description ? ` — ${marker.description}` : ""}`)].join("\n"),
      };
    }
    if (action === "list") {
      const snapshot = await deps.service.snapshot(space);
      return { output: await listing(space, snapshot, input, self, only) };
    }
    const named = Array.isArray(input.sessionIds)
      ? input.sessionIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    const sessionIds = named.length ? named : [text(input.sessionId) ?? self];
    if (only && sessionIds.some((id) => id !== only)) {
      throw Object.assign(new Error("This turn acts for no person, so it can mark only its own chat"), { code: "forbidden" });
    }
    if (action === "get") {
      const snapshot = await deps.service.snapshot(space);
      const sessions = snapshot.sessions.filter((session) => sessionIds.includes(session.sessionId));
      if (sessions.length === 0) return { output: `No markers on ${sessionIds.join(", ")}.` };
      const names = new Map<string, string | undefined>();
      const rows: string[] = [];
      for (const session of sessions) rows.push(await describe(space, session, snapshot.definitions, self, names));
      return { output: rows.join("\n") };
    }
    const reference = text(input.marker);
    if (!reference) throw invalidInput(`${action} needs a marker`);
    if (space.role === "viewer") throw Object.assign(new Error("Viewers can't change chat markers"), { code: "forbidden" });
    const snapshot = await deps.service.apply(space, action === "add"
      ? { sessionIds, add: [{ marker: reference, ...(input.note !== undefined ? { note: input.note } : {}) }], create: true }
      : { sessionIds, remove: [reference] }, { kind: "agent", sessionId: self });
    const marker = resolveMarker(snapshot.definitions, reference);
    const verb = action === "add" ? "Added" : "Removed";
    return {
      output: `${verb} “${marker?.label ?? reference}” (${marker?.id ?? reference}) ${action === "add" ? "to" : "from"} ${sessionIds.length === 1 && sessionIds[0] === self ? "this chat" : sessionIds.join(", ")}.`,
      metadata: { revision: snapshot.revision },
    };
  };

  return {
    descriptor: {
      id: SESSION_MARKERS_TOOL_ID,
      kind: "tool",
      owner: SESSION_MARKERS_PACKAGE_ID,
      scope: "deployment",
      revision: "1",
      name: SESSION_MARKERS_TOOL_NAME,
      description: `Find Polyth chats (sessions) by marker — ${builtInSummary} or custom — and add or remove markers. Use it whenever the user refers to chats that need review, to reply to later, important ones, or any other marker.`,
      inputSchema,
      trust: "workspace",
      mutating: true,
    },
    // Markers are reversible organizing metadata on chats the acting person
    // can already open; the user sees every change in the navigator.
    autoApprove: () => true,
    execute: run,
  };
}
