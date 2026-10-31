import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPermissionService } from "@polyth/permissions";

const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-perm-"));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("fail closed: unknown permission asks", () => {
  withDir((dir) => {
    const svc = createPermissionService(dir);
    assert.equal(svc.evaluate("bash", ["rm -rf /"]), "ask");
  });
});

test("user-scope allow applies everywhere", () => {
  withDir((dir) => {
    const svc = createPermissionService(dir);
    svc.addRule({ permission: "bash", pattern: "npm *", action: "allow", scope: "user" });
    assert.equal(svc.evaluate("bash", ["npm test"], "p1", "s1"), "allow");
    assert.equal(svc.evaluate("bash", ["npm test"], "p2", "s9"), "allow");
  });
});

test("session-scope allow is confined to that session", () => {
  withDir((dir) => {
    const svc = createPermissionService(dir);
    svc.addRule({ permission: "edit", pattern: "*", action: "allow", scope: "session", sessionId: "s1" });
    assert.equal(svc.evaluate("edit", ["src/a.ts"], "p1", "s1"), "allow");
    assert.equal(svc.evaluate("edit", ["src/a.ts"], "p1", "s2"), "ask");
    assert.equal(svc.evaluate("edit", ["src/a.ts"], "p1", undefined), "ask");
  });
});

test("project-scope allow is confined to that project", () => {
  withDir((dir) => {
    const svc = createPermissionService(dir);
    svc.addRule({ permission: "webfetch", pattern: "https://api.example.com*", action: "allow", scope: "project", projectId: "p1" });
    assert.equal(svc.evaluate("webfetch", ["https://api.example.com/v1"], "p1"), "allow");
    assert.equal(svc.evaluate("webfetch", ["https://api.example.com/v1"], "p2"), "ask");
  });
});

test("deny wins over allow regardless of scope", () => {
  withDir((dir) => {
    const svc = createPermissionService(dir);
    svc.addRule({ permission: "bash", pattern: "*", action: "allow", scope: "session", sessionId: "s1" });
    svc.addRule({ permission: "bash", pattern: "rm *", action: "deny", scope: "user" });
    assert.equal(svc.evaluate("bash", ["rm -rf node_modules"], "p1", "s1"), "deny");
    assert.equal(svc.evaluate("bash", ["ls"], "p1", "s1"), "allow");
  });
});

test("rules persist and legacy scopes fall back to user", () => {
  withDir((dir) => {
    const a = createPermissionService(dir);
    a.addRule({ permission: "bash", pattern: "git *", action: "allow", scope: "session", sessionId: "s1" });
    const b = createPermissionService(dir);
    assert.equal(b.evaluate("bash", ["git status"], undefined, "s1"), "allow");
    assert.equal(b.evaluate("bash", ["git status"], undefined, "s2"), "ask");
  });
});

test("same rule key replaces instead of duplicating", () => {
  withDir((dir) => {
    const svc = createPermissionService(dir);
    svc.addRule({ permission: "bash", pattern: "npm *", action: "allow", scope: "user" });
    svc.addRule({ permission: "bash", pattern: "npm *", action: "deny", scope: "user" });
    assert.equal(svc.rules().length, 1);
    assert.equal(svc.evaluate("bash", ["npm i"]), "deny");
  });
});
