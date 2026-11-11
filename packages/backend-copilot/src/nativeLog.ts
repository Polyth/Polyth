// Read-only access to GitHub Copilot CLI's own durable session records.
//
// The CLI keeps every session under `$COPILOT_HOME/session-state/<id>/`:
// `workspace.yaml` (working directory, name, timestamps) and an append-only
// `events.jsonl`. Its ACP prompt result carries only a turn total, with
// cached input folded into `inputTokens`; the log has one
// `session.usage_record` per model response. The log is also the native
// transcript the Snapshot import picker lists.
//
// Verified against Copilot CLI 1.0.109 (`session.start` `version: 1`). Any
// other log generation yields nothing rather than a guess.
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SourceRecord, SourceSession, TokenUsage } from "@polyth/contracts";

/** The `session.start` log generation this adapter was verified against. */
export const SUPPORTED_LOG_VERSION = 1;
const MAX_LOG_BYTES = 256 * 1024 * 1024;
/** A finished turn is read from the end of the log; a longer turn falls back
 *  to the whole file. */
const TAIL_BYTES = 4 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
const MAX_LISTED = 100;
const MAX_METADATA_BYTES = 64 * 1024;

/** `$COPILOT_HOME`, else `~/.copilot`, as the CLI resolves it; blank is unset. */
export const resolveCopilotHome = (env: NodeJS.ProcessEnv = process.env): string => {
    const configured = env.COPILOT_HOME?.trim();
    return configured ? resolve(configured) : join(homedir(), ".copilot");
};

export interface CopilotLogEvent {
    type: string;
    id?: string;
    /** Epoch milliseconds. */
    time?: number;
    data?: Record<string, unknown>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Parse log text. A torn final line is the row being written. */
export function parseLog(text: string): CopilotLogEvent[] {
    const events: CopilotLogEvent[] = [];
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let row: Record<string, unknown> | undefined;
        try {
            row = asRecord(JSON.parse(line));
        } catch {
            break;
        }
        if (!row || typeof row.type !== "string") continue;
        const time = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
        events.push({
            type: row.type,
            ...(typeof row.id === "string" ? { id: row.id } : {}),
            ...(Number.isFinite(time) ? { time } : {}),
            ...(asRecord(row.data) ? { data: asRecord(row.data)! } : {}),
        });
    }
    return events;
}

/** Session ids are one path segment (a UUID in practice). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const sessionDir = (home: string, sessionId: string): string | undefined =>
    SAFE_ID.test(sessionId) ? join(home, "session-state", sessionId) : undefined;

const supported = (events: readonly CopilotLogEvent[]): boolean => {
    const start = events.find((event) => event.type === "session.start");
    return start?.data?.version === SUPPORTED_LOG_VERSION;
};

/** The whole log of one session, or nothing for another log generation. */
export async function readNativeSession(home: string, sessionId: string): Promise<CopilotLogEvent[] | undefined> {
    const dir = sessionDir(home, sessionId);
    if (!dir) return undefined;
    const path = join(dir, "events.jsonl");
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_LOG_BYTES) return undefined;
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined) return undefined;
    const events = parseLog(text);
    return supported(events) ? events : undefined;
}

/**
 * The rows from the newest user prompt on, read from the end of the log so a
 * long session does not cost a full read per turn. The first row of a tail
 * that starts mid-file is partial and dropped.
 */
export async function readLatestPrompt(home: string, sessionId: string): Promise<CopilotLogEvent[] | undefined> {
    const dir = sessionDir(home, sessionId);
    if (!dir) return undefined;
    const path = join(dir, "events.jsonl");
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_LOG_BYTES) return undefined;
    const fromPrompt = (events: CopilotLogEvent[]): CopilotLogEvent[] | undefined => {
        for (let index = events.length - 1; index >= 0; index--) {
            if (isUserPrompt(events[index]!)) return events.slice(index);
        }
        return undefined;
    };
    if (info.size > TAIL_BYTES) {
        const handle = await open(path, "r").catch(() => undefined);
        if (handle) {
            try {
                // `session.start` is the first row; it names the generation.
                const head = Buffer.alloc(HEAD_BYTES);
                const first = await handle.read(head, 0, HEAD_BYTES, 0);
                if (!supported(parseLog(head.subarray(0, first.bytesRead).toString("utf8").split("\n", 1)[0]!))) return undefined;
                const bytes = Buffer.alloc(TAIL_BYTES);
                const { bytesRead } = await handle.read(bytes, 0, TAIL_BYTES, info.size - TAIL_BYTES);
                const text = bytes.subarray(0, bytesRead).toString("utf8");
                const tail = fromPrompt(parseLog(text.slice(text.indexOf("\n") + 1)));
                if (tail) return tail;
            } finally {
                await handle.close();
            }
        }
    }
    const events = await readNativeSession(home, sessionId);
    return events ? fromPrompt(events) ?? [] : undefined;
}

/** A prompt the person (or Polyth) sent, not a subagent's inner message. */
const isUserPrompt = (event: CopilotLogEvent): boolean =>
    event.type === "user.message" && typeof event.data?.content === "string" && !event.data.parentToolCallId;

export interface CopilotUsageRow {
    /** The log row's own id; stable across re-reads. */
    id: string;
    model: string;
    tokens: TokenUsage;
}

const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/**
 * Per-response usage of the newest prompt. Copilot's `inputTokens` is the
 * whole prompt, cache reads included (OpenAI accounting, verified against a
 * Chat Completions provider), so cache reads are taken out to give the
 * non-cached input of the shared `TokenUsage` convention.
 * `complete` is false until the last model response's turn has ended.
 */
export function latestPromptUsage(events: readonly CopilotLogEvent[]): { rows: CopilotUsageRow[]; complete: boolean } {
    let start = -1;
    for (let index = events.length - 1; index >= 0; index--) {
        if (isUserPrompt(events[index]!)) { start = index; break; }
    }
    if (start < 0) return { rows: [], complete: false };
    const rows: CopilotUsageRow[] = [];
    let open = 0;
    let ended = false;
    for (const event of events.slice(start + 1)) {
        if (event.type === "assistant.turn_start") { open++; ended = false; }
        else if (event.type === "assistant.turn_end") { open = Math.max(0, open - 1); ended = open === 0; }
        else if (event.type === "abort" || event.type === "session.error" || event.type === "session.shutdown") ended = true;
        if (event.type !== "session.usage_record" || !event.id) continue;
        const usage = asRecord(event.data?.usage);
        const model = typeof usage?.model === "string" && usage.model ? usage.model : undefined;
        const total = count(usage?.inputTokens);
        const output = count(usage?.outputTokens);
        if (!model || total === undefined || output === undefined) continue;
        const cacheRead = count(usage?.cacheReadTokens);
        const cacheWrite = count(usage?.cacheWriteTokens);
        const reasoning = count(usage?.reasoningTokens);
        rows.push({
            id: event.id,
            model,
            tokens: {
                input: Math.max(0, total - (cacheRead ?? 0)),
                output,
                ...(reasoning ? { reasoning } : {}),
                ...(cacheRead ? { cacheRead } : {}),
                ...(cacheWrite ? { cacheWrite } : {}),
            },
        });
    }
    return { rows, complete: ended };
}

/** Dialogue rows of a log: prompts and visible assistant text. Reasoning,
 *  injected instructions, tool traffic and subagent messages stay out. */
export function* dialogueRecords(events: readonly CopilotLogEvent[]): Iterable<SourceRecord> {
    for (const event of events) {
        if (isUserPrompt(event)) {
            const text = (event.data!.content as string).trim();
            if (text) yield { role: "user", text, ...(event.time ? { time: event.time } : {}) };
            continue;
        }
        if (event.type !== "assistant.message" || event.data?.parentToolCallId) continue;
        const text = typeof event.data?.content === "string" ? event.data.content.trim() : "";
        if (text) yield { role: "assistant", text, ...(event.time ? { time: event.time } : {}) };
    }
}

/** Top-level scalars of `workspace.yaml`, which the CLI writes one per line. */
export function parseWorkspaceYaml(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
        if (!match) continue;
        let value = match[2]!.trim();
        if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
            try { value = String(JSON.parse(value)); } catch { value = value.slice(1, -1); }
        } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
            value = value.slice(1, -1).replace(/''/g, "'");
        }
        out[match[1]!] = value;
    }
    return out;
}

const readWorkspace = async (dir: string): Promise<Record<string, string> | undefined> => {
    const path = join(dir, "workspace.yaml");
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_METADATA_BYTES) return undefined;
    const text = await readFile(path, "utf8").catch(() => undefined);
    return text === undefined ? undefined : parseWorkspaceYaml(text);
};

/** Native sessions of one workspace that hold a conversation, newest first. */
export async function listNativeSessions(home: string, cwd: string): Promise<SourceSession[]> {
    const root = join(home, "session-state");
    const wanted = resolve(cwd);
    let ids: string[];
    try {
        ids = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return [];
    }
    const found: Array<SourceSession & { updatedAt: number }> = [];
    for (const id of ids) {
        if (!SAFE_ID.test(id)) continue;
        const dir = join(root, id);
        const workspace = await readWorkspace(dir);
        if (!workspace?.cwd || resolve(workspace.cwd) !== wanted) continue;
        // A session that was opened but never prompted has no log.
        const log = await stat(join(dir, "events.jsonl")).catch(() => undefined);
        if (!log?.isFile() || log.size === 0) continue;
        found.push({ ref: id, title: (workspace.name?.trim() || "Copilot session").slice(0, 200), updatedAt: log.mtimeMs });
    }
    return found.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_LISTED);
}

const notFound = () => Object.assign(new Error("native session not found"), { code: "not-found" });

/** One native session's dialogue, only when it belongs to `cwd`. */
export async function* readNativeDialogue(home: string, cwd: string, ref: string): AsyncIterable<SourceRecord> {
    const dir = sessionDir(home, ref);
    const workspace = dir ? await readWorkspace(dir) : undefined;
    if (!workspace?.cwd || resolve(workspace.cwd) !== resolve(cwd)) throw notFound();
    const events = await readNativeSession(home, ref);
    if (!events) throw notFound();
    yield* dialogueRecords(events);
}
