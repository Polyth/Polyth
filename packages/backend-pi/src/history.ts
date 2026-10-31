import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { SourceRecord, SourceSession } from "@polyth/contracts";

/** Native Pi session files live under the agent directory, one file per
 * conversation. Reading them directly avoids importing the CLI package or
 * starting a runtime just to answer the import picker. */
const MAX_LISTED = 100;

export const piAgentDir = (): string =>
    process.env.POLYTH_PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");

/** Mirror of Pi's own cwd encoding for its `sessions/` directory. Only path
 * separators/colons are rewritten after the leading separator is dropped. */
export function piSessionDir(cwd: string, agentDir = piAgentDir()): string {
    const safePath = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return join(agentDir, "sessions", safePath);
}

const notFound = () => Object.assign(new Error("native session not found"), { code: "not-found" });

type ContentBlock = { type?: string; text?: unknown };

/** Pi stores message content as a string or an array of typed blocks. Only
 * user/assistant text becomes canonical history; thinking/tool blocks are not. */
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

const parseLine = (line: string): Record<string, unknown> | undefined => {
    if (!line) return undefined;
    try {
        const parsed: unknown = JSON.parse(line);
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
    }
    catch {
        // A torn final line is an interrupted write, not a parse failure worth
        // failing the whole listing for.
        return undefined;
    }
};

const messageRole = (entry: Record<string, unknown>): "user" | "assistant" | undefined => {
    const message = entry.message;
    if (!message || typeof message !== "object") return undefined;
    const role = (message as { role?: unknown }).role;
    return role === "user" || role === "assistant" ? role : undefined;
};

async function* readPiFile(file: string): AsyncIterable<SourceRecord> {
    const reader = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    try {
        for await (const line of reader) {
            const entry = parseLine(line);
            if (entry?.type !== "message") continue;
            const role = messageRole(entry);
            if (!role) continue;
            const text = textFromContent((entry.message as { content?: unknown }).content);
            if (!text.trim()) continue;
            const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
            yield { role, text, ...(Number.isFinite(time) ? { time } : {}) };
        }
    }
    finally {
        reader.close();
    }
}

export async function* readPiSession(
    context: { cwd: string },
    ref: string,
    agentDir = piAgentDir(),
): AsyncIterable<SourceRecord> {
    const root = resolve(piSessionDir(context.cwd, agentDir));
    const file = resolve(ref);
    if (file !== root && !file.startsWith(root + sep)) throw notFound();
    if (!existsSync(file)) throw notFound();
    yield* readPiFile(file);
}

async function readPiMetadata(file: string): Promise<{ title: string } | undefined> {
    const reader = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    let header = false;
    let name: string | undefined;
    let firstUser: string | undefined;
    let scanned = 0;
    try {
        for await (const line of reader) {
            const entry = parseLine(line);
            if (!entry) continue;
            if (entry.type === "session") {
                header = true;
                continue;
            }
            if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
                name = entry.name.trim();
                if (firstUser) break;
                continue;
            }
            if (!firstUser && entry.type === "message" && messageRole(entry) === "user") {
                const text = textFromContent((entry.message as { content?: unknown }).content).trim();
                if (text) firstUser = text;
                if (name) break;
            }
            // Titles are written near the start; stop before scanning a whole
            // multi-megabyte transcript just to list it.
            if (++scanned > 4_000) break;
        }
    }
    finally {
        reader.close();
    }
    if (!header) return undefined;
    return { title: (name || firstUser || "Pi session").replace(/\s+/g, " ").slice(0, 200) };
}

export async function listPiSessions(cwd: string, agentDir = piAgentDir()): Promise<SourceSession[]> {
    const dir = piSessionDir(cwd, agentDir);
    let names: string[];
    try {
        names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
    }
    catch {
        return [];
    }
    const stated = await Promise.all(names.map(async (name) => {
        const file = join(dir, name);
        const info = await stat(file).catch(() => undefined);
        return info ? { file, mtime: info.mtimeMs } : undefined;
    }));
    const recent = stated
        .filter((item): item is { file: string; mtime: number } => Boolean(item))
        .sort((left, right) => right.mtime - left.mtime)
        .slice(0, MAX_LISTED);
    const sessions: SourceSession[] = [];
    for (const item of recent) {
        const meta = await readPiMetadata(item.file);
        if (!meta) continue;
        sessions.push({ ref: item.file, title: meta.title, updatedAt: item.mtime });
    }
    return sessions;
}
