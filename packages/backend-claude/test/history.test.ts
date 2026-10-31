import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeProjectDir, listClaudeSessions, readClaudeSession } from "../src/history.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test("Claude history lists native sessions and ignores tool/sidechain records", async () => {
    const projectsDir = await mkdtemp(join(tmpdir(), "polyth-claude-history-"));
    try {
        const cwd = join(projectsDir, "workspace");
        const dir = claudeProjectDir(cwd, projectsDir);
        await mkdir(dir, { recursive: true });
        const file = join(dir, "session-1.jsonl");
        await writeFile(file, [
            line({ type: "ai-title", aiTitle: "Title fix", sessionId: "session-1" }),
            line({ type: "user", isSidechain: false, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "fix it" }] } }),
            line({ type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
            line({ type: "assistant", isSidechain: false, timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "done" }] } }),
            line({ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "text", text: "subagent" }] } }),
        ].join(""));

        const sessions = await listClaudeSessions(cwd, projectsDir);
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0]!.title, "Title fix");

        const records = [];
        for await (const record of readClaudeSession({ cwd }, sessions[0]!.ref, projectsDir)) records.push(record);
        assert.deepEqual(records.map((record) => `${record.role}:${record.text}`), ["user:fix it", "assistant:done"]);

        await assert.rejects(async () => {
            for await (const _ of readClaudeSession({ cwd }, join(projectsDir, "escape.jsonl"), projectsDir)) { /* noop */ }
        }, /native session not found/);
    }
    finally {
        await rm(projectsDir, { recursive: true, force: true });
    }
});

test("Claude history falls back to the first user text when no title exists", async () => {
    const projectsDir = await mkdtemp(join(tmpdir(), "polyth-claude-history-fallback-"));
    try {
        const cwd = join(projectsDir, "workspace");
        const dir = claudeProjectDir(cwd, projectsDir);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "session-2.jsonl"), [
            line({ type: "user", message: { role: "user", content: "fix the import picker" } }),
            line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } }),
        ].join(""));
        const sessions = await listClaudeSessions(cwd, projectsDir);
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0]!.title, "fix the import picker");
    }
    finally {
        await rm(projectsDir, { recursive: true, force: true });
    }
});
