import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jwtExpiry, parseCursorAuthReport, readCursorAuthReport, readCursorSessionEnd } from "../src/authStatus.ts";

import { after } from "node:test";
import { rmSync } from "node:fs";

const tempDirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(prefix);
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 10, 9);
const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString("base64url")}.s`;
const configWith = (refreshToken: string) => {
    const root = tempDir(join(tmpdir(), "cursor-auth-"));
    mkdirSync(join(root, "cursor"));
    writeFileSync(join(root, "cursor", "auth.json"), JSON.stringify({ accessToken: refreshToken, refreshToken }));
    return root;
};
const report = (fields: Record<string, unknown>) => JSON.stringify({ status: "authenticated", hasAccessToken: true, hasRefreshToken: true, ...fields });

test("a confirmed sign-in carries the account and the session's end", () => {
    const end = NOW + 86_400_000;
    assert.deepEqual(parseCursorAuthReport(report({ isAuthenticated: true, userInfo: { email: "a@example.com" } }), end, NOW), { loggedIn: true, email: "a@example.com", expiresAt: end });
});

test("tokens Cursor no longer accepts read as signed out once the session ended", () => {
    // `agent status` still says isAuthenticated: true, without userInfo.
    const stale = report({ isAuthenticated: true, message: "Logged in (unable to fetch user details)" });
    assert.equal(parseCursorAuthReport(stale, NOW - 1, NOW).loggedIn, false);
    // Not yet ended, but unconfirmed: neither signed in nor out.
    assert.equal(parseCursorAuthReport(stale, NOW + 60_000, NOW).loggedIn, "unknown");
    assert.equal(parseCursorAuthReport(stale, undefined, NOW).loggedIn, "unknown");
});

test("the CLI's own signed-out and unreadable reports", () => {
    assert.equal(parseCursorAuthReport(JSON.stringify({ isAuthenticated: false }), undefined, NOW).loggedIn, false);
    assert.equal(parseCursorAuthReport("not json", undefined, NOW).loggedIn, "unknown");
    assert.equal(parseCursorAuthReport("{}", undefined, NOW).loggedIn, "unknown");
});

test("the session's end comes from the stored refresh token's exp only", async () => {
    const end = NOW - 4 * 86_400_000;
    assert.equal(await readCursorSessionEnd(configWith(jwt(end)), NOW), Math.floor(end / 1000) * 1000);
    assert.equal(await readCursorSessionEnd(configWith("opaque-token"), NOW), undefined);
    assert.equal(await readCursorSessionEnd(join(tmpdir(), "no-such-cursor-config"), NOW), undefined);
    assert.equal(jwtExpiry("a.b", NOW), undefined);
});

test("an ended session is signed out even when the CLI fails or prints nothing", async () => {
    const root = configWith(jwt(NOW - 1000));
    const failed = await readCursorAuthReport(() => Promise.reject(Object.assign(new Error("exit 1"), { stdout: "" })), root, () => NOW);
    assert.equal(failed.loggedIn, false);
    const printed = await readCursorAuthReport(() => Promise.resolve({ stdout: report({ isAuthenticated: true }) }), root, () => NOW);
    assert.equal(printed.loggedIn, false);
    const unanswered = await readCursorAuthReport(() => Promise.reject(new Error("timeout")), configWith(jwt(NOW + 60_000)), () => NOW);
    assert.equal(unanswered.loggedIn, "unknown");
});
