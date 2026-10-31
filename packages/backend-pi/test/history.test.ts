import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listPiSessions, piSessionDir, readPiSession } from "../src/history.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test("Pi history lists native sessions and reads only user/assistant text", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "polyth-pi-history-"));
    try {
        const cwd = join(agentDir, "workspace");
        const dir = piSessionDir(cwd, agentDir);
        await mkdir(dir, { recursive: true });
        const file = join(dir, "2026-01-01T00-00-00-000Z_abc.jsonl");
        await writeFile(file, [
            line({ type: "session", version: 3, id: "abc", timestamp: "2026-01-01T00:00:00.000Z", cwd }),
            line({ type: "session_info", id: "n1", name: "  Debug resume error  " }),
            line({ type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
            line({ type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "hi" }, { type: "toolCall", name: "x" }] } }),
            line({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } }),
        ].join(""));

        const sessions = await listPiSessions(cwd, agentDir);
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0]!.title, "Debug resume error");

        const records = [];
        for await (const record of readPiSession({ cwd }, sessions[0]!.ref, agentDir)) records.push(record);
        assert.deepEqual(records.map((record) => `${record.role}:${record.text}`), ["user:hello", "assistant:hi"]);
        assert.equal(records[0]!.time, Date.parse("2026-01-01T00:00:01.000Z"));

        // A reference outside the cwd's native directory is rejected.
        await assert.rejects(async () => {
            for await (const _ of readPiSession({ cwd }, join(agentDir, "..", "escape.jsonl"), agentDir)) { /* noop */ }
        }, /native session not found/);
    }
    finally {
        await rm(agentDir, { recursive: true, force: true });
    }
});

test("Pi history returns an empty list for a workspace with no native sessions", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "polyth-pi-history-empty-"));
    try {
        assert.deepEqual(await listPiSessions(join(agentDir, "missing"), agentDir), []);
    }
    finally {
        await rm(agentDir, { recursive: true, force: true });
    }
});
