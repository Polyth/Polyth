import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { listCursorSessions, readCursorSession } from "../src/history.ts";

const createStore = (file: string, blobs: Array<string | Buffer>) => {
    const db = new DatabaseSync(file);
    try {
        db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
        const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
        blobs.forEach((blob, index) => {
            insert.run(`blob-${index}`, typeof blob === "string" ? Buffer.from(blob) : blob);
        });
    }
    finally {
        db.close();
    }
};

test("Cursor history lists ACP sessions for the matching cwd and reads dialogue in row order", async () => {
    const root = await mkdtemp(join(tmpdir(), "polyth-cursor-history-"));
    try {
        const cwd = join(root, "workspace");
        const good = join(root, "session-1");
        const otherCwd = join(root, "session-other");
        await mkdir(good, { recursive: true });
        await mkdir(otherCwd, { recursive: true });
        await writeFile(join(good, "meta.json"), JSON.stringify({ schemaVersion: 1, cwd, title: "Import picker" }));
        await writeFile(join(otherCwd, "meta.json"), JSON.stringify({ schemaVersion: 1, cwd: "/somewhere/else", title: "Nope" }));
        createStore(join(good, "store.db"), [
            JSON.stringify({ role: "system", content: "system prompt" }),
            JSON.stringify({ role: "user", content: "hello there" }),
            Buffer.from([0, 1, 2, 3, 4, 5]),
            JSON.stringify({ role: "assistant", content: [{ type: "reasoning", text: "secret" }, { type: "text", text: "hi" }] }),
            JSON.stringify({ role: "tool", content: [{ type: "tool-result", text: "ignored" }] }),
        ]);
        createStore(join(otherCwd, "store.db"), [JSON.stringify({ role: "user", content: "elsewhere" })]);

        const sessions = await listCursorSessions(cwd, root);
        assert.deepEqual(sessions.map((session) => session.title), ["Import picker"]);

        const records = [];
        for await (const record of readCursorSession({ cwd }, sessions[0]!.ref, root)) records.push(record);
        assert.deepEqual(records.map((record) => `${record.role}:${record.text}`), ["user:hello there", "assistant:hi"]);

        // A ref for a session recorded under another cwd is rejected.
        await assert.rejects(async () => {
            for await (const _ of readCursorSession({ cwd }, otherCwd, root)) { /* noop */ }
        }, /native session not found/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
