import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { SourceRecord, SourceSession } from "@polyth/contracts";

/** Claude Code writes one JSONL transcript per session under a project
 * directory derived from the working directory. Polyth reads that native
 * transcript directly; the Agent SDK is not started for an import listing. */
const MAX_LISTED = 100;

export const claudeProjectsDir = (): string =>
    process.env.POLYTH_CLAUDE_PROJECTS_DIR?.trim() || join(homedir(), ".claude", "projects");

/** Claude Code replaces every non-alphanumeric cwd character with `-`. */
export function claudeProjectDir(cwd: string, projectsDir = claudeProjectsDir()): string {
    const encoded = resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
    return join(projectsDir, encoded);
}

const notFound = () => Object.assign(new Error("native session not found"), { code: "not-found" });

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

const parseLine = (line: string): Record<string, unknown> | undefined => {
    if (!line) return undefined;
    try {
        const parsed: unknown = JSON.parse(line);
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
    }
    catch {
        return undefined;
    }
};

const dialogueRole = (entry: Record<string, unknown>): "user" | "assistant" | undefined => {
    if (entry.type !== "user" && entry.type !== "assistant") return undefined;
    // Sidechains are subagent/tool transcripts, not the parent conversation.
    if (entry.isSidechain === true) return undefined;
    return entry.type;
};

const messageContent = (entry: Record<string, unknown>): unknown => {
    const message = entry.message;
    return message && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
};

async function* readClaudeFile(file: string): AsyncIterable<SourceRecord> {
    const reader = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    try {
        for await (const line of reader) {
            const entry = parseLine(line);
            if (!entry) continue;
            const role = dialogueRole(entry);
            if (!role) continue;
            const text = textFromContent(messageContent(entry));
            if (!text.trim()) continue;
            const raw = entry.timestamp;
            const time = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
            yield { role, text, ...(Number.isFinite(time) ? { time } : {}) };
        }
    }
    finally {
        reader.close();
    }
}

export async function* readClaudeSession(
    context: { cwd: string },
    ref: string,
    projectsDir = claudeProjectsDir(),
): AsyncIterable<SourceRecord> {
    const root = resolve(claudeProjectDir(context.cwd, projectsDir));
    const file = resolve(ref);
    if (file !== root && !file.startsWith(root + sep)) throw notFound();
    if (!existsSync(file)) throw notFound();
    yield* readClaudeFile(file);
}

async function readClaudeMetadata(file: string): Promise<{ title: string } | undefined> {
    const reader = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    let sawDialogue = false;
    let title: string | undefined;
    let firstUser: string | undefined;
    let scanned = 0;
    try {
        for await (const line of reader) {
            const entry = parseLine(line);
            if (!entry) continue;
            if (entry.type === "ai-title" && typeof entry.aiTitle === "string" && entry.aiTitle.trim()) {
                title = entry.aiTitle.trim();
                if (firstUser) break;
                continue;
            }
            const role = dialogueRole(entry);
            if (!role) continue;
            sawDialogue = true;
            if (!firstUser && role === "user") {
                const text = textFromContent(messageContent(entry)).trim();
                if (text) firstUser = text;
                if (title) break;
            }
            // Titles are written near the start; stop before scanning a whole
            // multi-megabyte transcript just to list it.
            if (++scanned > 4_000) break;
        }
    }
    finally {
        reader.close();
    }
    if (!sawDialogue) return undefined;
    return { title: (title || firstUser || "Claude session").replace(/\s+/g, " ").slice(0, 200) };
}

export async function listClaudeSessions(cwd: string, projectsDir = claudeProjectsDir()): Promise<SourceSession[]> {
    const dir = claudeProjectDir(cwd, projectsDir);
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
        const meta = await readClaudeMetadata(item.file);
        if (!meta) continue;
        sessions.push({ ref: item.file, title: meta.title, updatedAt: item.mtime });
    }
    return sessions;
}
