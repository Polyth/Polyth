import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_VERSION_STORE, createCursorProfile } from "../src/serverEntry.ts";

test("Cursor prunes only its installer's side-by-side releases", () => {
    const versions = "/home/me/.local/share/cursor-agent/versions";
    assert.equal(CURSOR_VERSION_STORE.directory(`${versions}/2026.10.16-e3cb207/cursor-agent`), versions);
    assert.equal(CURSOR_VERSION_STORE.directory("/usr/lib/node_modules/cursor-agent/bin/cursor-agent"), undefined);
    assert.equal(CURSOR_VERSION_STORE.directory("/opt/cursor/versions/2026.10.16-e3cb207/cursor-agent"), undefined);
    assert.equal(CURSOR_VERSION_STORE.entry.test("2026.10.16-e3cb207"), true);
    assert.equal(CURSOR_VERSION_STORE.entry.test("2026.10.16-e3cb207.tmp"), false);
    assert.equal(createCursorProfile().versionStore, CURSOR_VERSION_STORE);
});
