// Claude Code's own memory files: `<projects dir>/<project path>/memory/*.md`,
// one note per file with frontmatter, and MEMORY.md as their index. Polyth
// reads them only to hand them over to Polyth memory, never edits them.
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NativeMemoryNote } from "@polyth/contracts";

/** Set on a launch whose project's Polyth memory replaces Claude Code's own. */
export const DISABLE_AUTO_MEMORY_ENV = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";
const MAX_FILES = 500;
const MAX_FILE_BYTES = 64 * 1024;

const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, "$2").trim();

/** One note file: `---` frontmatter with `name`, `description` and a `type`
 *  (top-level or under `metadata:`), then the body. */
export function parseClaudeMemoryNote(file: string, text: string): NativeMemoryNote | undefined {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    const fields = new Map<string, string>();
    for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
        const field = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(line);
        if (field && field[2] && !fields.has(field[1]!)) fields.set(field[1]!, unquote(field[2]));
    }
    const body = (match ? match[2]! : text).trim();
    const title = fields.get("description") || fields.get("name") || file.replace(/\.md$/i, "");
    if (!body) return undefined;
    const type = fields.get("type");
    return { file, title, body, ...(type ? { type } : {}) };
}

/** Every note in a project's memory directory; none when it does not exist. */
export async function readClaudeMemoryNotes(dir: string): Promise<NativeMemoryNote[]> {
    let names: string[];
    try {
        names = await readdir(dir);
    }
    catch {
        return [];
    }
    const notes: NativeMemoryNote[] = [];
    for (const name of names.filter((entry) => /\.md$/i.test(entry) && entry !== "MEMORY.md").sort().slice(0, MAX_FILES)) {
        const path = join(dir, name);
        // A link could point anywhere on this machine: only plain files.
        const info = await lstat(path).catch(() => undefined);
        if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue;
        const note = parseClaudeMemoryNote(name, await readFile(path, "utf8"));
        if (note) notes.push(note);
    }
    return notes;
}
