// Chat markers: the vocabulary, its validation and the pure operations on one
// Space's marker document. Browser-safe — the widgets and the server share it.

export const SESSION_MARKERS_PACKAGE_ID = "session-markers";
export const SESSION_MARKERS_DOCUMENT_VERSION = 1;

export const MARKER_COLORS = ["amber", "blue", "red", "green", "purple", "accent", "gray"] as const;
export type MarkerColor = typeof MARKER_COLORS[number];

export const MARKER_ICONS = ["eye", "clock", "flag", "tag", "star", "bolt", "bug", "question", "check", "heart"] as const;
export type MarkerIcon = typeof MARKER_ICONS[number];

export const MARKER_LABEL_MAX = 40;
export const MARKER_DESCRIPTION_MAX = 200;
export const MARKER_NOTE_MAX = 280;
export const MARKER_CUSTOM_MAX = 50;
export const MARKERS_PER_SESSION_MAX = 10;

export interface MarkerDefinition {
  /** Stable slug. Agents and the API address a marker by it (or its label). */
  id: string;
  label: string;
  description?: string;
  color: MarkerColor;
  icon: MarkerIcon;
  builtIn: boolean;
}

/** Who put a marker on a chat: a person, or the agent of a chat. */
export type MarkerActor =
  | { kind: "person"; userId?: string }
  | { kind: "agent"; sessionId: string };

export interface SessionMarker {
  id: string;
  at: number;
  by: MarkerActor;
  note?: string;
}

/** The predefined markers every Space has. Their ids are the contract agents
 *  rely on ("needs-review" means the same thing everywhere). */
export const BUILT_IN_MARKERS: readonly MarkerDefinition[] = [
  {
    id: "needs-review",
    label: "Needs review",
    description: "The work in this chat is finished and waits for a review (code review, checking the result).",
    color: "amber",
    icon: "eye",
    builtIn: true,
  },
  {
    id: "reply-later",
    label: "Reply later",
    description: "Come back to this chat and answer it later.",
    color: "blue",
    icon: "clock",
    builtIn: true,
  },
  {
    id: "important",
    label: "Important",
    description: "This chat matters more than the rest; keep it in sight.",
    color: "red",
    icon: "flag",
    builtIn: true,
  },
];

/** One chat as the API reports it: only chats the caller can open. */
export interface MarkedSession {
  sessionId: string;
  projectId: string;
  title: string;
  archived: boolean;
  updatedAt: number;
  markers: SessionMarker[];
}

/** `GET /api/session-markers` and every mutation's answer. */
export interface MarkersSnapshot {
  revision: number;
  definitions: MarkerDefinition[];
  sessions: MarkedSession[];
}

export interface MarkerDocument {
  version: typeof SESSION_MARKERS_DOCUMENT_VERSION;
  revision: number;
  /** Custom markers only; built-ins are never stored. */
  definitions: MarkerDefinition[];
  sessions: Record<string, SessionMarker[]>;
}

export const emptyMarkerDocument = (): MarkerDocument => ({
  version: SESSION_MARKERS_DOCUMENT_VERSION,
  revision: 0,
  definitions: [],
  sessions: {},
});

export const invalidInput = (message: string): Error => Object.assign(new Error(message), { code: "invalid-input" });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Collapse whitespace and strip control characters. */
const cleanText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
};

/** The id a label gets, and the form a marker reference is matched in:
 *  "Needs review", "needs_review" and "NEEDS-REVIEW" all name `needs-review`.
 *  Letters of every script are kept so a Cyrillic label has a real id. */
export function markerSlug(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export const isMarkerColor = (value: unknown): value is MarkerColor =>
  typeof value === "string" && (MARKER_COLORS as readonly string[]).includes(value);
export const isMarkerIcon = (value: unknown): value is MarkerIcon =>
  typeof value === "string" && (MARKER_ICONS as readonly string[]).includes(value);

/** A stable color for a new custom marker that names none. */
export function defaultMarkerColor(id: string): MarkerColor {
  const palette: readonly MarkerColor[] = ["purple", "green", "accent", "amber", "blue", "gray"];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return palette[hash % palette.length]!;
}

export function allDefinitions(document: Pick<MarkerDocument, "definitions">): MarkerDefinition[] {
  return [...BUILT_IN_MARKERS.map((marker) => ({ ...marker })), ...document.definitions.map((marker) => ({ ...marker }))];
}

/** Find a marker by id or label, forgiving case, spaces and punctuation. */
export function resolveMarker(definitions: readonly MarkerDefinition[], reference: string): MarkerDefinition | undefined {
  const slug = markerSlug(reference);
  if (!slug) return undefined;
  return definitions.find((marker) => marker.id === slug)
    ?? definitions.find((marker) => markerSlug(marker.label) === slug);
}

const parseActor = (value: unknown): MarkerActor => {
  if (isRecord(value) && value.kind === "agent" && typeof value.sessionId === "string" && value.sessionId) {
    return { kind: "agent", sessionId: value.sessionId };
  }
  if (isRecord(value) && typeof value.userId === "string" && value.userId) return { kind: "person", userId: value.userId };
  return { kind: "person" };
};

const parseDefinition = (value: unknown): MarkerDefinition | undefined => {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const id = markerSlug(value.id);
  const label = cleanText(value.label, MARKER_LABEL_MAX);
  if (!id || id !== value.id || !label) return undefined;
  if (BUILT_IN_MARKERS.some((marker) => marker.id === id)) return undefined;
  const description = cleanText(value.description, MARKER_DESCRIPTION_MAX);
  return {
    id,
    label,
    ...(description ? { description } : {}),
    color: isMarkerColor(value.color) ? value.color : defaultMarkerColor(id),
    icon: isMarkerIcon(value.icon) ? value.icon : "tag",
    builtIn: false,
  };
};

/** Read a stored document leniently: an unknown marker entry is dropped, never
 *  the whole document. An unsupported version is refused. */
export function parseMarkerDocument(value: unknown): MarkerDocument {
  if (!isRecord(value) || value.version !== SESSION_MARKERS_DOCUMENT_VERSION) {
    throw Object.assign(new Error("chat markers use an unsupported storage format"), { code: "storage-unavailable" });
  }
  const definitions: MarkerDefinition[] = [];
  for (const entry of Array.isArray(value.definitions) ? value.definitions : []) {
    const definition = parseDefinition(entry);
    if (definition && !definitions.some((known) => known.id === definition.id)) definitions.push(definition);
  }
  const known = new Set(allDefinitions({ definitions }).map((marker) => marker.id));
  const sessions: Record<string, SessionMarker[]> = {};
  for (const [sessionId, entries] of Object.entries(isRecord(value.sessions) ? value.sessions : {})) {
    if (!Array.isArray(entries)) continue;
    const markers: SessionMarker[] = [];
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.id !== "string" || !known.has(entry.id)) continue;
      if (markers.some((marker) => marker.id === entry.id)) continue;
      const note = cleanText(entry.note, MARKER_NOTE_MAX);
      markers.push({
        id: entry.id,
        at: typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : 0,
        by: parseActor(entry.by),
        ...(note ? { note } : {}),
      });
    }
    if (markers.length) sessions[sessionId] = markers.slice(0, MARKERS_PER_SESSION_MAX);
  }
  const revision = Number(value.revision);
  return {
    version: SESSION_MARKERS_DOCUMENT_VERSION,
    revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
    definitions,
    sessions,
  };
}

export interface MarkerDefinitionInput {
  label?: unknown;
  description?: unknown;
  color?: unknown;
  icon?: unknown;
}

/** Add a custom marker, or return the existing one the label already names. */
export function defineMarker(document: MarkerDocument, input: MarkerDefinitionInput): { document: MarkerDocument; marker: MarkerDefinition; created: boolean } {
  const label = cleanText(input.label, MARKER_LABEL_MAX);
  if (!label) throw invalidInput("A marker needs a name");
  const existing = resolveMarker(allDefinitions(document), label);
  if (existing) return { document, marker: existing, created: false };
  const id = markerSlug(label);
  if (!id) throw invalidInput("A marker name needs at least one letter or digit");
  if (document.definitions.length >= MARKER_CUSTOM_MAX) {
    throw invalidInput(`A Space can have at most ${MARKER_CUSTOM_MAX} custom markers`);
  }
  if (input.color !== undefined && !isMarkerColor(input.color)) throw invalidInput("Unknown marker color");
  if (input.icon !== undefined && !isMarkerIcon(input.icon)) throw invalidInput("Unknown marker icon");
  const description = cleanText(input.description, MARKER_DESCRIPTION_MAX);
  const marker: MarkerDefinition = {
    id,
    label,
    ...(description ? { description } : {}),
    color: isMarkerColor(input.color) ? input.color : defaultMarkerColor(id),
    icon: isMarkerIcon(input.icon) ? input.icon : "tag",
    builtIn: false,
  };
  return { document: { ...document, definitions: [...document.definitions, marker] }, marker, created: true };
}

/** Rename or restyle a custom marker. Its id stays, so chats keep it. */
export function updateMarker(document: MarkerDocument, id: string, input: MarkerDefinitionInput): MarkerDocument {
  if (BUILT_IN_MARKERS.some((marker) => marker.id === id)) throw invalidInput("Predefined markers can't be changed");
  const current = document.definitions.find((marker) => marker.id === id);
  if (!current) throw Object.assign(new Error("Unknown marker"), { code: "not-found" });
  const label = input.label === undefined ? current.label : cleanText(input.label, MARKER_LABEL_MAX);
  if (!label) throw invalidInput("A marker needs a name");
  const clash = resolveMarker(allDefinitions(document).filter((marker) => marker.id !== id), label);
  if (clash) throw Object.assign(new Error(`A marker named “${clash.label}” already exists`), { code: "conflict" });
  if (input.color !== undefined && !isMarkerColor(input.color)) throw invalidInput("Unknown marker color");
  if (input.icon !== undefined && !isMarkerIcon(input.icon)) throw invalidInput("Unknown marker icon");
  const description = input.description === undefined ? current.description : cleanText(input.description, MARKER_DESCRIPTION_MAX);
  const next: MarkerDefinition = {
    id,
    label,
    ...(description ? { description } : {}),
    color: isMarkerColor(input.color) ? input.color : current.color,
    icon: isMarkerIcon(input.icon) ? input.icon : current.icon,
    builtIn: false,
  };
  return { ...document, definitions: document.definitions.map((marker) => marker.id === id ? next : marker) };
}

/** Delete a custom marker and take it off every chat. */
export function removeMarkerDefinition(document: MarkerDocument, id: string): MarkerDocument {
  if (BUILT_IN_MARKERS.some((marker) => marker.id === id)) throw invalidInput("Predefined markers can't be deleted");
  if (!document.definitions.some((marker) => marker.id === id)) throw Object.assign(new Error("Unknown marker"), { code: "not-found" });
  const sessions: Record<string, SessionMarker[]> = {};
  for (const [sessionId, markers] of Object.entries(document.sessions)) {
    const kept = markers.filter((marker) => marker.id !== id);
    if (kept.length) sessions[sessionId] = kept;
  }
  return { ...document, definitions: document.definitions.filter((marker) => marker.id !== id), sessions };
}

export interface MarkerAddition {
  marker: string;
  note?: unknown;
}

export interface MarkerChange {
  sessionIds: readonly string[];
  add?: readonly MarkerAddition[];
  remove?: readonly string[];
  /** Take every marker off before adding. */
  clear?: boolean;
  /** Create a custom marker for an addition that names none yet. */
  create?: boolean;
}

/** Apply one change to several chats. Re-adding a marker a chat has keeps its
 *  original time and author and updates the note only when one is given. */
export function applyMarkerChange(
  document: MarkerDocument,
  change: MarkerChange,
  by: MarkerActor,
  now: number,
): { document: MarkerDocument; created: MarkerDefinition[] } {
  let next = document;
  const created: MarkerDefinition[] = [];
  const additions: Array<{ id: string; note?: string; noteGiven: boolean }> = [];
  for (const addition of change.add ?? []) {
    let marker = resolveMarker(allDefinitions(next), addition.marker);
    if (!marker) {
      if (!change.create) throw Object.assign(new Error(`Unknown marker “${addition.marker}”`), { code: "not-found" });
      const defined = defineMarker(next, { label: addition.marker });
      next = defined.document;
      marker = defined.marker;
      if (defined.created) created.push(marker);
    }
    const note = cleanText(addition.note, MARKER_NOTE_MAX);
    additions.push({ id: marker.id, ...(note ? { note } : {}), noteGiven: addition.note !== undefined });
  }
  const definitions = allDefinitions(next);
  const removals = new Set((change.remove ?? []).map((reference) => resolveMarker(definitions, reference)?.id).filter((id): id is string => !!id));
  const sessions = { ...next.sessions };
  for (const sessionId of change.sessionIds) {
    let markers = change.clear ? [] : (sessions[sessionId] ?? []).filter((marker) => !removals.has(marker.id));
    for (const addition of additions) {
      const current = markers.find((marker) => marker.id === addition.id);
      if (current) {
        if (!addition.noteGiven) continue;
        const { note: _previous, ...rest } = current;
        markers = markers.map((marker) => marker === current ? { ...rest, ...(addition.note ? { note: addition.note } : {}) } : marker);
        continue;
      }
      if (markers.length >= MARKERS_PER_SESSION_MAX) throw invalidInput(`A chat can have at most ${MARKERS_PER_SESSION_MAX} markers`);
      markers = [...markers, { id: addition.id, at: now, by, ...(addition.note ? { note: addition.note } : {}) }];
    }
    if (markers.length) sessions[sessionId] = markers;
    else delete sessions[sessionId];
  }
  return { document: { ...next, sessions }, created };
}
