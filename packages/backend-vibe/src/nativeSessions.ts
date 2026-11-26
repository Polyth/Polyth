// Vibe's own sessions, for the Snapshot import picker.
//
// Vibe 3.x keeps each session in `$VIBE_HOME/logs/session/unified/<id>/`
// (`session_logging.save_dir`): a `meta.json` (id, `environment.working_directory`,
// `title`, `start_time`, `bumped_at`, `parent_session_id`) beside a
// content-addressed snapshot store whose format is internal to its Rust
// runtime. The listing reads `meta.json` only. The dialogue is read the way
// Vibe itself publishes it: ACP `session/load`, which replays the history as
// `user_message_chunk` / `agent_message_chunk` updates before it answers.
import { readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HarnessContext, SourceRecord, SourceSession } from "@polyth/contracts";
import { connectAcp, type AcpProfile } from "@polyth/backend-acp";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_LISTED = 100;
const MAX_META_BYTES = 256 * 1024;
const LOAD_TIMEOUT_MS = 60_000;
const MAX_RECORDS = 5_000;

/** `VIBE_HOME`, else `~/.vibe` (Vibe's own resolution). */
export const resolveVibeHome = (env: NodeJS.ProcessEnv = process.env): string => {
    const configured = env.VIBE_HOME?.trim();
    return configured ? resolve(configured.replace(/^~(?=$|[\\/])/, homedir())) : join(homedir(), ".vibe");
};

const sessionsRoot = (home: string) => join(home, "logs", "session", "unified");

interface VibeSessionMeta {
    id: string;
    cwd?: string;
    title?: string;
    parent?: string;
    updatedAt?: number;
}

const time = (value: unknown): number | undefined => {
    if (typeof value !== "string" || !value) return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

export function parseVibeSessionMeta(id: string, text: string): VibeSessionMeta | undefined {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return undefined; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const meta = raw as Record<string, unknown>;
    if (meta.session_id !== id) return undefined;
    const environment = meta.environment && typeof meta.environment === "object" ? meta.environment as Record<string, unknown> : {};
    const cwd = typeof environment.working_directory === "string" ? environment.working_directory : undefined;
    const title = typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : undefined;
    const parent = typeof meta.parent_session_id === "string" && meta.parent_session_id ? meta.parent_session_id : undefined;
    const updatedAt = time(meta.bumped_at) ?? time(meta.end_time) ?? time(meta.start_time);
    return { id, ...(cwd ? { cwd } : {}), ...(title ? { title } : {}), ...(parent ? { parent } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}) };
}

const readMeta = async (home: string, id: string): Promise<VibeSessionMeta | undefined> => {
    if (!SAFE_ID.test(id)) return undefined;
    const text = await readFile(join(sessionsRoot(home), id, "meta.json"), "utf8").catch(() => undefined);
    return text && text.length <= MAX_META_BYTES ? parseVibeSessionMeta(id, text) : undefined;
};

/** Top-level sessions of `cwd`, newest first. A native subagent's session
 *  belongs to its parent and is not listed on its own. */
export async function listVibeSessions(home: string, cwd: string): Promise<SourceSession[]> {
    const wanted = resolve(cwd);
    let ids: string[];
    try {
        ids = (await readdir(sessionsRoot(home), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
        return [];
    }
    const found: Array<SourceSession & { updatedAt: number }> = [];
    for (const id of ids) {
        const meta = await readMeta(home, id);
        if (!meta?.cwd || meta.parent || resolve(meta.cwd) !== wanted) continue;
        found.push({ ref: id, title: (meta.title ?? "Mistral Vibe session").slice(0, 200), updatedAt: meta.updatedAt ?? 0 });
    }
    return found.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_LISTED);
}

const notFound = () => Object.assign(new Error("native session not found"), { code: "not-found" });

/** Fold replayed message chunks into one record per message id. */
export function foldReplay(updates: readonly Record<string, unknown>[]): SourceRecord[] {
    const records: SourceRecord[] = [];
    let current: { id?: string; role: SourceRecord["role"] } | undefined;
    for (const update of updates) {
        const role = update.sessionUpdate === "user_message_chunk" ? "user"
            : update.sessionUpdate === "agent_message_chunk" ? "assistant"
                : undefined;
        if (!role) continue;
        const content = update.content && typeof update.content === "object" ? update.content as Record<string, unknown> : undefined;
        if (content?.type !== "text" || typeof content.text !== "string" || !content.text) continue;
        const id = typeof update.messageId === "string" ? update.messageId : undefined;
        const last = records.at(-1);
        if (last && current && current.role === role && (id === undefined ? current.id === undefined : current.id === id)) {
            last.text += content.text;
            continue;
        }
        if (records.length >= MAX_RECORDS) break;
        records.push({ role, text: content.text });
        current = { ...(id !== undefined ? { id } : {}), role };
    }
    return records.filter((entry) => entry.text.trim());
}

/** One native session's dialogue, only when it belongs to `cwd`. */
export async function* readVibeDialogue(
    profile: Pick<AcpProfile, "command" | "args" | "env" | "descriptor" | "probe">,
    home: string,
    cwd: string,
    ref: string,
): AsyncIterable<SourceRecord> {
    const meta = await readMeta(home, ref);
    if (!meta?.cwd || resolve(meta.cwd) !== resolve(cwd)) throw notFound();
    const connection = await connectAcp(profile as AcpProfile, { spaceId: "", projectId: "", cwd: meta.cwd } as HarnessContext);
    const updates: Record<string, unknown>[] = [];
    try {
        connection.rpc.onNotification((method, params) => {
            if (method !== "session/update" || params?.sessionId !== ref) return;
            if (params.update && typeof params.update === "object") updates.push(params.update as Record<string, unknown>);
        });
        await connection.rpc.request("session/load", { sessionId: ref, cwd: meta.cwd, mcpServers: [] }, LOAD_TIMEOUT_MS);
        await connection.rpc.request("session/close", { sessionId: ref }, 5_000).catch(() => {});
    } catch (error) {
        if ((error as { rpcCode?: unknown }).rpcCode === -32602) throw notFound();
        // Vibe holds a session's lease in one process at a time (a Polyth chat
        // on it, or Vibe's own terminal UI).
        if (/already open/i.test((error as { remoteMessage?: string }).remoteMessage ?? "")) {
            throw Object.assign(new Error("This session is open in another Mistral Vibe process; close it there and try again"), { code: "conflict" });
        }
        throw error;
    } finally {
        await connection.rpc.close().catch(() => {});
    }
    yield* foldReplay(updates);
}

/** A directory of its own for checks that open a throwaway session. */
export const vibeCheckDir = () => join(tmpdir(), "polyth-vibe-check");
