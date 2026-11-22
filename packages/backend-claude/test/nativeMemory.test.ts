import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseClaudeMemoryNote, readClaudeMemoryNotes } from "../src/nativeMemory.ts";

test("a Claude Code memory file becomes one note: description as title, nested type, body", () => {
    const note = parseClaudeMemoryNote("fridge.md", [
        "---",
        "name: fridge-inventory",
        "description: \"Keep the kitchen inventory from photos\"",
        "metadata:",
        "  type: feedback",
        "---",
        "",
        "Ask for new photos after shopping.",
        "**Why:** the user asked.",
    ].join("\n"));
    assert.deepEqual(note, { file: "fridge.md", title: "Keep the kitchen inventory from photos", body: "Ask for new photos after shopping.\n**Why:** the user asked.", type: "feedback" });
    assert.equal(parseClaudeMemoryNote("plain.md", "Just a body")?.title, "plain", "no frontmatter: the file name");
    assert.equal(parseClaudeMemoryNote("empty.md", "---\nname: x\n---\n"), undefined, "nothing to keep");
});

test("reading a memory directory skips the index, other files and links", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-memory-"));
    try {
        const dir = join(root, "memory");
        await mkdir(dir);
        await writeFile(join(dir, "MEMORY.md"), "- [Fridge](fridge.md)\n");
        await writeFile(join(dir, "fridge.md"), "---\nname: fridge\n---\nEggs 10\n");
        await writeFile(join(dir, "notes.txt"), "not a note");
        await writeFile(join(root, "outside.md"), "---\nname: outside\n---\nsecret elsewhere\n");
        await symlink(join(root, "outside.md"), join(dir, "linked.md"));
        assert.deepEqual((await readClaudeMemoryNotes(dir)).map((note) => note.file), ["fridge.md"]);
        assert.deepEqual(await readClaudeMemoryNotes(join(root, "missing")), []);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
