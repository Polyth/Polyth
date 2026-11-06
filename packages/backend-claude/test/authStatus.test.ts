import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseClaudeAuthReport, parseLoginExpiresAt, readClaudeAuthReport } from "../src/authStatus.ts";
import { createClaudeProvider } from "../src/serverEntry.ts";

const NOW = Date.UTC(2026, 10, 4, 12);
const ENDS = "2026-11-26T08:12:53.381Z";

test("a 2.1.318 report carries the sign-in end; older reports have none", () => {
    assert.deepEqual(parseClaudeAuthReport(JSON.stringify({
        loggedIn: true, authMethod: "claude.ai", email: "person@example.test", subscriptionType: "pro", loginExpiresAt: ENDS,
    }), NOW), { loggedIn: true, email: "person@example.test", plan: "pro", expiresAt: Date.parse(ENDS) });
    // 2.1.314 printed no expiry; a null email (the default login) is left out.
    assert.deepEqual(parseClaudeAuthReport(JSON.stringify({ loggedIn: true, email: null, subscriptionType: "max" }), NOW),
        { loggedIn: true, plan: "max" });
    // A signed-out report keeps nothing, not even a date.
    assert.deepEqual(parseClaudeAuthReport(JSON.stringify({ loggedIn: false, loginExpiresAt: ENDS }), NOW), { loggedIn: false });
});

test("only a JSON report with a boolean loggedIn counts as an answer", () => {
    assert.equal(parseClaudeAuthReport("", NOW), undefined);
    assert.equal(parseClaudeAuthReport("Logged in as someone", NOW), undefined);
    assert.equal(parseClaudeAuthReport("null", NOW), undefined);
    assert.equal(parseClaudeAuthReport(JSON.stringify({ email: "x" }), NOW), undefined);
    assert.equal(parseClaudeAuthReport(JSON.stringify({ loggedIn: "yes" }), NOW), undefined);
});

test("loginExpiresAt accepts ISO and epoch values and rejects implausible ones", () => {
    assert.equal(parseLoginExpiresAt(ENDS, NOW), Date.parse(ENDS));
    assert.equal(parseLoginExpiresAt(Date.parse(ENDS), NOW), Date.parse(ENDS));
    assert.equal(parseLoginExpiresAt(Date.parse(ENDS) / 1000, NOW), Date.parse(ENDS));
    // An ended sign-in still has a date worth showing.
    assert.equal(parseLoginExpiresAt("2026-11-01T00:00:00Z", NOW), Date.UTC(2026, 10, 1));
    for (const value of ["", "soon", "1999-01-01T00:00:00Z", "2040-01-01T00:00:00Z", 0, Number.NaN, null, {}, true]) {
        assert.equal(parseLoginExpiresAt(value, NOW), undefined, `rejects ${JSON.stringify(value)}`);
    }
});

test("a report that never arrived is unknown, never signed out", async () => {
    const fail = (error: object) => readClaudeAuthReport(() => Promise.reject(Object.assign(new Error("Command failed: claude auth status --json\nsecond line"), error)), () => NOW);
    assert.deepEqual(await fail({ killed: true, signal: "SIGTERM" }), { loggedIn: "unknown", reason: "the CLI did not answer in time" });
    assert.deepEqual(await fail({ code: "ENOENT" }), { loggedIn: "unknown", reason: "the CLI could not start (ENOENT)" });
    assert.deepEqual(await fail({ code: 3, stdout: "", stderr: "Error: config is corrupt\nstack" }), { loggedIn: "unknown", reason: "Error: config is corrupt" });
    assert.deepEqual(await fail({ code: 1 }), { loggedIn: "unknown", reason: "Command failed: claude auth status --json" });
    // A signed-out CLI exits non-zero and still prints its report.
    assert.deepEqual(await fail({ code: 1, stdout: JSON.stringify({ loggedIn: false }) }), { loggedIn: false });
    assert.deepEqual(await readClaudeAuthReport(async () => ({ stdout: "<html>" }), () => NOW),
        { loggedIn: "unknown", reason: "the CLI printed an unreadable report" });
});

/** A fake `claude` whose `auth status` answer comes from FAKE_AUTH. */
function fakeClaude(t: { after(fn: () => void): void }) {
    const root = mkdtempSync(join(tmpdir(), "polyth-claude-auth-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "claude");
    writeFileSync(bin, [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "2.1.318 (Claude Code)"; exit 0; fi',
        'case "$FAKE_AUTH" in',
        `  signed-in) echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","loginExpiresAt":"${ENDS}"}' ;;`,
        `  signed-out) echo '{"loggedIn":false}'; exit 1 ;;`,
        "  *) echo 'Error: config is corrupt' >&2; exit 3 ;;",
        "esac",
    ].join("\n"));
    chmodSync(bin, 0o755);
    const saved = { bin: process.env.POLYTH_CLAUDE_BIN, auth: process.env.FAKE_AUTH, key: process.env.ANTHROPIC_API_KEY };
    process.env.POLYTH_CLAUDE_BIN = bin;
    delete process.env.ANTHROPIC_API_KEY;
    t.after(() => {
        for (const [key, value] of [["POLYTH_CLAUDE_BIN", saved.bin], ["FAKE_AUTH", saved.auth], ["ANTHROPIC_API_KEY", saved.key]] as const) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    return root;
}

test("the probe reports the sign-in end and treats a failed report as unverified", async (t) => {
    const root = fakeClaude(t);
    const host = { pluginId: "backend-claude" } as unknown as Parameters<typeof createClaudeProvider>[0];
    const provider = createClaudeProvider(host);
    const context = { spaceId: "s", projectId: "p", cwd: root } as Parameters<typeof provider.probe>[0];

    process.env.FAKE_AUTH = "signed-in";
    assert.deepEqual(await provider.probe(context), {
        harnessId: "claude", installed: true, healthy: true, authenticated: true, authExpiresAt: Date.parse(ENDS), version: "2.1.318 (Claude Code)",
    });

    process.env.FAKE_AUTH = "signed-out";
    assert.deepEqual(await provider.probe(context), {
        harnessId: "claude", installed: true, healthy: true, authenticated: false, version: "2.1.318 (Claude Code)",
    });

    process.env.FAKE_AUTH = "broken";
    const warned: unknown[][] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => { warned.push(args); });
    const broken = await provider.probe(context);
    assert.equal(broken.authenticated, "unknown");
    assert.equal(broken.message, "Could not check the Claude Code sign-in: Error: config is corrupt");
    assert.equal(broken.authExpiresAt, undefined);
    await provider.probe(context);
    assert.equal(warned.length, 1, "the same reason is logged once");
});
