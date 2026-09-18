// Prompt history is a bounded view over durable composer submissions — not a
// second table. The limit is a recall window; conversation rows are never pruned.
//
// Eligibility (both scopes):
//   * `user/message` that is non-empty after parse, excluding githubConflictResolution
//   * composer-shell `tool/call` (`producer = composer-shell`) recalled as `!command`
// Hidden events follow canonical `effectiveHistory` rewind semantics: an active
// rewind hides `atSeq <= seq < markerSeq`, and a replaced clear keeps that range
// hidden. Session content is Space-shared (events have no actor id).
import { parseBrowserContext, type AttachmentRef, type PromptHistoryEntryDto } from "@polyth/contracts";

export interface PromptHistoryCandidateRow {
  sessionId: string;
  projectId: string | null;
  worktreePath: string | null;
  seq: number;
  id: string;
  time: number;
  type: string;
  data: string;
}

export interface RewindMarkerRow {
  sessionId: string;
  seq: number;
  type: string;
  data: string;
}

function parseStoredAttachments(raw: unknown): AttachmentRef[] {
  if (!Array.isArray(raw)) return [];
  const out: AttachmentRef[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const a = item as {
      id?: unknown; name?: unknown; mime?: unknown; size?: unknown;
      kind?: unknown; path?: unknown; url?: unknown; range?: unknown;
      browserContext?: unknown;
    };
    if (typeof a.name !== "string" || typeof a.mime !== "string") continue;
    const id = typeof a.id === "string" && a.id ? a.id : `hist-${out.length}`;
    const size = Number.isSafeInteger(a.size) && Number(a.size) >= 0 ? Number(a.size) : 0;
    if (a.kind === "browser-context") {
      const browserContext = parseBrowserContext(a.browserContext);
      if (!browserContext) continue;
      out.push({
        id, name: a.name, mime: a.mime, size,
        kind: "browser-context",
        browserContext,
        ...(typeof a.url === "string" ? { url: a.url } : {}),
      });
      continue;
    }
    const range = Array.isArray(a.range) && a.range.length === 2
      && Number.isSafeInteger(a.range[0]) && Number.isSafeInteger(a.range[1])
      ? [Number(a.range[0]), Number(a.range[1])] as [number, number]
      : undefined;
    const kind = a.kind === "image" || a.kind === "range" || a.kind === "url" || a.kind === "file"
      ? a.kind
      : undefined;
    out.push({
      id, name: a.name, mime: a.mime, size,
      ...(kind ? { kind } : {}),
      ...(typeof a.path === "string" ? { path: a.path } : {}),
      ...(typeof a.url === "string" ? { url: a.url } : {}),
      ...(range ? { range } : {}),
    });
  }
  return out;
}

function promptTextFromEventData(data: { raw?: unknown; text?: unknown }): string {
  if (typeof data.raw === "string" && data.raw.length > 0) return data.raw;
  if (typeof data.text === "string") return data.text;
  return "";
}

function shellCommandFromPayload(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { tool?: unknown; input?: unknown };
  if (o.tool !== "shell") return null;
  const command = o.input && typeof o.input === "object"
    && typeof (o.input as { command?: unknown }).command === "string"
    ? (o.input as { command: string }).command
    : "";
  const trimmed = command.trim();
  return trimmed ? `!${trimmed}` : null;
}

export function parsePromptHistoryCandidate(row: PromptHistoryCandidateRow): PromptHistoryEntryDto | null {
  let data: unknown;
  try {
    data = JSON.parse(row.data) as unknown;
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const payload = data as {
    raw?: unknown;
    text?: unknown;
    attachments?: unknown;
    githubConflictResolution?: unknown;
    hiddenUserMessage?: unknown;
    autoResume?: unknown;
  };
  let text = "";
  let attachments: AttachmentRef[] = [];
  if (row.type === "user/message") {
    if (payload.githubConflictResolution === true
      || payload.hiddenUserMessage === true
      || payload.autoResume === true) return null;
    text = promptTextFromEventData(payload);
    attachments = parseStoredAttachments(payload.attachments);
  } else if (row.type === "tool/call") {
    const command = shellCommandFromPayload(data);
    if (!command) return null;
    text = command;
  } else {
    return null;
  }
  if (!text.trim() && attachments.length === 0) return null;
  const worktreePath = typeof row.worktreePath === "string" && row.worktreePath
    ? row.worktreePath
    : undefined;
  return {
    id: row.id,
    sessionId: row.sessionId,
    projectId: row.projectId ?? "",
    ...(worktreePath ? { worktreePath } : {}),
    seq: row.seq,
    time: row.time,
    text,
    attachments,
  };
}

/** Replay one session's rewind markers the same way `effectiveHistory` hides a tail. */
export function rewindVisibility(
  markers: readonly RewindMarkerRow[],
): (seq: number) => boolean {
  const list = [...markers].sort((a, b) => a.seq - b.seq);
  let hidden: { atSeq: number; markerSeq: number } | null = null;
  const ranges: Array<{ from: number; to: number }> = [];
  for (const ev of list) {
    if (ev.type === "session/rewound") {
      let data: { atSeq?: unknown };
      try { data = JSON.parse(ev.data) as { atSeq?: unknown }; } catch { continue; }
      const atSeq = Number(data.atSeq);
      if (Number.isSafeInteger(atSeq) && atSeq > 0) {
        hidden = { atSeq, markerSeq: ev.seq };
      }
      continue;
    }
    if (ev.type === "session/rewind-cleared" && hidden) {
      let data: { rewindSeq?: unknown; replaced?: unknown };
      try { data = JSON.parse(ev.data) as { rewindSeq?: unknown; replaced?: unknown }; } catch { continue; }
      const markerMatches = data.rewindSeq === undefined
        || Number(data.rewindSeq) === hidden.markerSeq;
      if (!markerMatches) continue;
      // A running turn may continue appending after the marker. Replacement
      // discards that whole stale tail through the resolving clear event, not
      // only the rows that existed when Revert was pressed.
      if (data.replaced === true) ranges.push({ from: hidden.atSeq, to: ev.seq });
      hidden = null;
    }
  }
  const active = hidden;
  return (seq) => {
    if (active && seq >= active.atSeq) return true;
    return ranges.some((range) => seq >= range.from && seq < range.to);
  };
}
