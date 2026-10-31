import { existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SourceRecord, SourceSession } from "@polyth/contracts";

/** Cursor Agent stores each ACP session as a directory holding `meta.json`
 * plus a SQLite blob store. Message blobs are plaintext JSON ordered by rowid;
 * the picker can therefore list and read native conversations without starting
 * the agent or replaying the protocol. */
const MAX_LISTED = 100;

export const cursorSessionsDir = (): string =>
    process.env.POLYTH_CURSOR_SESSIONS_DIR?.trim() || join(homedir(), ".cursor", "acp-sessions");

const notFound = () => Object.assign(new Error("native session not found"), { code: "not-found" });

type CursorMeta = { cwd?: unknown; title?: unknown };

type ContentBlock = { type?: string; text?: unknown };

const textFromContent = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((block): block is ContentBlock => Boolean(block) && typeof block === "object")
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .filter(Boolean)
        .join("\n");
};

const readMeta = (dir: string): CursorMeta | undefined => {
    try {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
        return parsed && typeof parsed === "object" ? parsed as CursorMeta : undefined;
    }
    catch {
        return undefined;
    }
};

/** Read dialogue rows in insertion order. `rowid` is the only stable sequence
 * the blob store exposes, and the ACP agent appends one blob per message.
 * Rows stream so a large session never has to be materialized at once. */
function* readRecords(db: DatabaseSync): Iterable<SourceRecord> {
    const rows = db.prepare("select data from blobs order by rowid").iterate() as Iterable<{ data: Uint8Array | Buffer }>;
    for (const row of rows) {
        let entry: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(Buffer.from(row.data).toString("utf8"));
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
            entry = parsed as Record<string, unknown>;
        }
        catch {
            // Binary tree/blob rows are not messages; skip them.
            continue;
        }
        const role = entry.role;
        if (role !== "user" && role !== "assistant") continue;
        const text = textFromContent(entry.content);
        if (!text.trim()) continue;
        yield { role, text };
    }
}

export async function listCursorSessions(cwd: string, root = cursorSessionsDir()): Promise<SourceSession[]> {
    const base = resolve(root);
    let names: string[];
    try {
        names = (await readdir(base, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    }
    catch {
        return [];
    }
    const wantedCwd = resolve(cwd);
    const found: Array<{ ref: string; title: string; updatedAt: number }> = [];
    for (const name of names) {
        const dir = join(base, name);
        const meta = readMeta(dir);
        if (typeof meta?.cwd !== "string" || resolve(meta.cwd) !== wantedCwd) continue;
        const dbFile = join(dir, "store.db");
        const info = await stat(dbFile).catch(() => undefined);
        if (!info) continue;
        const title = typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : "Cursor session";
        found.push({ ref: dir, title: title.slice(0, 200), updatedAt: info.mtimeMs });
    }
    return found
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_LISTED);
}

export async function* readCursorSession(
    context: { cwd: string },
    ref: string,
    root = cursorSessionsDir(),
): AsyncIterable<SourceRecord> {
    const base = resolve(root);
    const dir = resolve(ref);
    if (dir === base || !dir.startsWith(base + sep)) throw notFound();
    const meta = readMeta(dir);
    if (typeof meta?.cwd !== "string" || resolve(meta.cwd) !== resolve(context.cwd)) throw notFound();
    const dbFile = join(dir, "store.db");
    if (!existsSync(dbFile)) throw notFound();
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
        yield* readRecords(db);
    }
    finally {
        db.close();
    }
}
