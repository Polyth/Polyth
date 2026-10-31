import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAUDE_VERSION_STORE, createClaudeProvider } from "../src/serverEntry.ts";

test("Claude Code prunes only its native installer's side-by-side versions", () => {
    const versions = "/home/me/.local/share/claude/versions";
    assert.equal(CLAUDE_VERSION_STORE.directory(`${versions}/2.1.304`), versions);
    assert.equal(CLAUDE_VERSION_STORE.directory("/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"), undefined);
    assert.equal(CLAUDE_VERSION_STORE.directory("/opt/homebrew/Caskroom/claude-code/versions/2.1.304"), undefined);
    assert.equal(CLAUDE_VERSION_STORE.entry.test("2.1.304"), true);
    assert.equal(CLAUDE_VERSION_STORE.entry.test("2.1.304.download"), false);
    const host = { pluginId: "backend-claude" } as unknown as Parameters<typeof createClaudeProvider>[0];
    assert.equal(createClaudeProvider(host).versionStore, CLAUDE_VERSION_STORE);
});
