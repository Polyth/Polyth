// Read-only access to DeepSeek Harness's own durable session logs.
//
// `dsh` persists every session as an append-only JSONL log under
// `$DSH_HOME/sessions/--<normalized-cwd>--/<session-id>/session.v<N>.jsonl`,
// compressed by default as one checksummed Zstandard frame per written batch
// (`.jsonl.zstd`). Its ACP surface omits per-response token usage, but each
// `assistant/message` row in this log carries it. The log is also the native
// transcript the Snapshot import picker lists.
//
// Only the current format generation this adapter was verified against is
// interpreted; any other generation yields nothing rather than a guess.
import * as zlib from "node:zlib";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SourceRecord, SourceSession } from "@polyth/contracts";

/** The session-log generation verified against dsh 0.2.x. */
export const SUPPORTED_LOG_VERSION = 4;
const LOG_FILE = /^session\.v(\d+)\.jsonl(\.zstd)?$/;
const MAX_LOG_BYTES = 256 * 1024 * 1024;
const MAX_LISTED = 100;
const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;

/** `$DSH_HOME`, else `~/.dsh`, exactly as dsh resolves it; blank is unset. */
export const resolveDshHome = (env: NodeJS.ProcessEnv = process.env): string => {
    const configured = env.DSH_HOME?.trim();
    return configured ? resolve(configured) : join(homedir(), ".dsh");
};

type ZstdDecompress = (buffer: Buffer, options?: { maxOutputLength?: number }) => Buffer;
/** Node gained Zstandard in 22.15 / 23.8; older runtimes read no logs. */
const zstdDecompress = (zlib as unknown as { zstdDecompressSync?: ZstdDecompress }).zstdDecompressSync;
export const zstdAvailable = (): boolean => typeof zstdDecompress === "function";

/**
 * Split a byte stream into complete Zstandard frames by walking frame and
 * block headers (RFC 8878 §3.1). Node's decoder stops after the first frame,
 * and searching for the magic number would also match compressed payload.
 * A truncated or malformed tail (a batch still being written) ends the walk.
 */
export function zstdFrames(buffer: Buffer): Buffer[] {
    const frames: Buffer[] = [];
    let offset = 0;
    while (offset + 4 <= buffer.length) {
        const magic = buffer.readUInt32LE(offset);
        if ((magic & SKIPPABLE_MAGIC_MASK) >>> 0 === SKIPPABLE_MAGIC) {
            if (offset + 8 > buffer.length) break;
            offset += 8 + buffer.readUInt32LE(offset + 4);
            continue;
        }
        if (magic !== ZSTD_MAGIC) break;
        let cursor = offset + 4;
        if (cursor >= buffer.length) break;
        const descriptor = buffer[cursor++]!;
        const contentSizeFlag = descriptor >> 6;
        const singleSegment = (descriptor >> 5) & 1;
        const hasChecksum = (descriptor >> 2) & 1;
        const dictionaryFlag = descriptor & 3;
        if (!singleSegment) cursor += 1;
        cursor += [0, 1, 2, 4][dictionaryFlag]!;
        cursor += contentSizeFlag === 0 ? singleSegment : [0, 2, 4, 8][contentSizeFlag]!;
        let last = false;
        let truncated = false;
        while (!last) {
            if (cursor + 3 > buffer.length) { truncated = true; break; }
            const header = buffer[cursor]! | (buffer[cursor + 1]! << 8) | (buffer[cursor + 2]! << 16);
            cursor += 3;
            last = (header & 1) === 1;
            const type = (header >> 1) & 3;
            if (type === 3) { truncated = true; break; }
            cursor += type === 1 ? 1 : header >>> 3;
        }
        if (truncated) break;
        if (hasChecksum) cursor += 4;
        if (cursor > buffer.length) break;
        frames.push(buffer.subarray(offset, cursor));
        offset = cursor;
    }
    return frames;
}

/** Decode a log file's bytes into text. A frame that fails to decode ends the
 *  readable prefix: later frames cannot be ordered after a gap. */
export function decodeLogBytes(bytes: Buffer, compressed: boolean): string {
    if (!compressed) return bytes.toString("utf8");
    if (!zstdDecompress) return "";
    let text = "";
    for (const frame of zstdFrames(bytes)) {
        try {
            text += zstdDecompress(frame, { maxOutputLength: MAX_LOG_BYTES }).toString("utf8");
        } catch {
            break;
        }
        if (text.length > MAX_LOG_BYTES) break;
    }
    return text;
}

export interface DshLogEvent {
    type: string;
    seq?: number;
    time?: number;
    data?: Record<string, unknown>;
}

export interface DshLogHeader {
    id: string;
    version: number;
    cwd?: string;
    createdAt?: number;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Parse decoded log text. The first row is the physical header. */
export function parseLog(text: string): { header?: DshLogHeader; events: DshLogEvent[] } {
    const events: DshLogEvent[] = [];
    let header: DshLogHeader | undefined;
    let first = true;
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let row: Record<string, unknown> | undefined;
        try {
            row = asRecord(JSON.parse(line));
        } catch {
            // A torn final line is the batch being written; nothing after it.
            break;
        }
        if (!row || typeof row.type !== "string") continue;
        if (first) {
            first = false;
            if (row.type === "session" && typeof row.id === "string" && typeof row.version === "number") {
                header = {
                    id: row.id,
                    version: row.version,
                    ...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
                    ...(typeof row.createdAt === "number" ? { createdAt: row.createdAt } : {}),
                };
                continue;
            }
        }
        events.push({
            type: row.type,
            ...(typeof row.seq === "number" ? { seq: row.seq } : {}),
            ...(typeof row.time === "number" ? { time: row.time } : {}),
            ...(asRecord(row.data) ? { data: asRecord(row.data)! } : {}),
        });
    }
    return { ...(header ? { header } : {}), events };
}

/** The newest log generation in one session directory. */
async function logFileIn(dir: string): Promise<{ path: string; version: number; compressed: boolean } | undefined> {
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        return undefined;
    }
    let best: { path: string; version: number; compressed: boolean } | undefined;
    for (const name of names) {
        const match = LOG_FILE.exec(name);
        if (!match) continue;
        const version = Number(match[1]);
        const compressed = Boolean(match[2]);
        // At one generation the raw file is preferred: it is what a
        // compression-disabled deployment is writing now.
        if (!best || version > best.version || (version === best.version && !compressed)) {
            best = { path: join(dir, name), version, compressed };
        }
    }
    return best;
}

async function readSessionDir(dir: string): Promise<{ header?: DshLogHeader; events: DshLogEvent[]; mtimeMs: number } | undefined> {
    const file = await logFileIn(dir);
    if (!file || file.version !== SUPPORTED_LOG_VERSION) return undefined;
    const info = await stat(file.path).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_LOG_BYTES) return undefined;
    const bytes = await readFile(file.path).catch(() => undefined);
    if (!bytes) return undefined;
    const parsed = parseLog(decodeLogBytes(bytes, file.compressed));
    if (parsed.header?.version !== SUPPORTED_LOG_VERSION) return undefined;
    return { ...parsed, mtimeMs: info.mtimeMs };
}

/** Session ids are one escaped path segment; a UUID is its own escape. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Locate and read one session's log by its native id. */
export async function readNativeSession(home: string, sessionId: string): Promise<{ header: DshLogHeader; events: DshLogEvent[]; mtimeMs: number } | undefined> {
    if (!SAFE_ID.test(sessionId)) return undefined;
    const root = join(home, "sessions");
    let projects: string[];
    try {
        projects = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return undefined;
    }
    for (const project of projects) {
        const read = await readSessionDir(join(root, project, sessionId));
        if (read?.header && read.header.id === sessionId) return { ...read, header: read.header };
    }
    return undefined;
}

export interface DshUsageRow {
    messageId: string;
    provider: string;
    model: string;
    tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

const userSourced = (event: DshLogEvent): boolean =>
    event.type === "user/message" && asRecord(event.data?.source)?.kind === "user";

/**
 * Per-response usage for the latest user prompt: every model response after
 * the newest user-authored message. dsh's `inputTokens` is the provider's
 * non-cached input (Anthropic Messages semantics), with cache reads and
 * writes counted separately — the shared `TokenUsage` convention as is.
 * `complete` is false until that prompt's turn has ended in the log.
 */
export function latestPromptUsage(events: readonly DshLogEvent[]): { rows: DshUsageRow[]; complete: boolean } {
    let start = -1;
    for (let index = events.length - 1; index >= 0; index--) {
        if (userSourced(events[index]!)) { start = index; break; }
    }
    if (start < 0) return { rows: [], complete: false };
    const rows: DshUsageRow[] = [];
    let complete = false;
    for (const event of events.slice(start + 1)) {
        if (event.type === "turn/end") complete = true;
        if (event.type !== "assistant/message") continue;
        const message = asRecord(event.data?.message);
        const source = asRecord(message?.source);
        const usage = asRecord(event.data?.usage);
        const messageId = typeof message?.id === "string" ? message.id : undefined;
        const provider = typeof source?.provider === "string" ? source.provider : undefined;
        const model = typeof source?.model === "string" ? source.model : undefined;
        const input = count(usage?.inputTokens);
        const output = count(usage?.outputTokens);
        if (!messageId || !provider || !model || input === undefined || output === undefined) continue;
        const cacheRead = count(usage?.cacheReadTokens);
        const cacheWrite = count(usage?.cacheWriteTokens);
        rows.push({
            messageId,
            provider,
            model,
            tokens: {
                input,
                output,
                ...(cacheRead !== undefined ? { cacheRead } : {}),
                ...(cacheWrite !== undefined ? { cacheWrite } : {}),
            },
        });
    }
    return { rows, complete };
}

/** Whether a user-authored prompt reached the agent's turn at or after
 *  `since` (epoch ms, same host clock): proof that a sent prompt was admitted. */
export const promptRecordedSince = (events: readonly DshLogEvent[], since: number): boolean =>
    events.some((event) => userSourced(event) && typeof event.time === "number" && event.time >= since);

const textBlocks = (content: unknown): string =>
    (Array.isArray(content) ? content : [])
        .map(asRecord)
        .filter((block): block is Record<string, unknown> => block?.type === "text" && typeof block.text === "string")
        .map((block) => (block.text as string).trim())
        .filter(Boolean)
        .join("\n\n");

/** Dialogue rows of a log: user-authored prompts and visible assistant text.
 *  Reasoning, injected instructions/context and tool traffic stay out. */
export function* dialogueRecords(events: readonly DshLogEvent[]): Iterable<SourceRecord> {
    for (const event of events) {
        if (userSourced(event)) {
            const text = textBlocks(event.data?.content);
            if (text) yield { role: "user", text, ...(event.time ? { time: event.time } : {}) };
            continue;
        }
        if (event.type !== "assistant/message") continue;
        const text = textBlocks(asRecord(event.data?.message)?.content);
        if (text) yield { role: "assistant", text, ...(event.time ? { time: event.time } : {}) };
    }
}

const titleOf = (events: readonly DshLogEvent[]): string => {
    for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index]!;
        if (event.type === "session/title" && typeof event.data?.title === "string" && event.data.title.trim()) {
            return event.data.title.trim();
        }
    }
    for (const record of dialogueRecords(events)) {
        if (record.role === "user") return record.text.split("\n")[0]!.trim();
    }
    return "DeepSeek session";
};

/** Native root sessions of one workspace, newest first. */
export async function listNativeSessions(home: string, cwd: string): Promise<SourceSession[]> {
    const root = join(home, "sessions");
    const wanted = resolve(cwd);
    let projects: string[];
    try {
        projects = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return [];
    }
    const found: Array<SourceSession & { updatedAt: number }> = [];
    for (const project of projects) {
        let ids: string[];
        try {
            ids = (await readdir(join(root, project), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
        } catch {
            continue;
        }
        for (const id of ids) {
            if (!SAFE_ID.test(id)) continue;
            const read = await readSessionDir(join(root, project, id));
            if (!read?.header?.cwd || resolve(read.header.cwd) !== wanted || read.header.id !== id) continue;
            // A session without a user prompt has nothing to import.
            if (!read.events.some(userSourced)) continue;
            found.push({ ref: id, title: titleOf(read.events).slice(0, 200), updatedAt: read.mtimeMs });
        }
    }
    return found.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_LISTED);
}

const notFound = () => Object.assign(new Error("native session not found"), { code: "not-found" });

/** One native session's dialogue, only when it belongs to `cwd`. */
export async function* readNativeDialogue(home: string, cwd: string, ref: string): AsyncIterable<SourceRecord> {
    const read = await readNativeSession(home, ref);
    if (!read?.header.cwd || resolve(read.header.cwd) !== resolve(cwd)) throw notFound();
    yield* dialogueRecords(read.events);
}
