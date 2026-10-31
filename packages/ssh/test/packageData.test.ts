import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerPackageHost } from "@polyth/plugins";
import registerPackage from "../src/serverEntry.ts";
import type { SshService } from "../src/index.ts";

const temporary = (): string => mkdtempSync(join(tmpdir(), "polyth-ssh-data-"));

/** A registration host that captures the services the package provides. */
function captureHost(root: string): { host: ServerPackageHost; provided: unknown[] } {
  const provided: unknown[] = [];
  const host = {
    pluginId: "ssh",
    storageDir: root,
    services: {
      provide: (_key: unknown, value: unknown) => { provided.push(value); },
      get: () => undefined,
      require: () => { throw new Error("unexpected service require during registration"); },
    },
  } as unknown as ServerPackageHost;
  return { host, provided };
}

function sshService(provided: unknown[]): SshService {
  const service = provided.find((value): value is SshService =>
    !!value && typeof (value as SshService).list === "function" && typeof (value as SshService).create === "function");
  assert.ok(service, "the package must provide its SshService");
  return service;
}

test("a legacy ssh.json in the shared data root is adopted and read back", () => {
  const root = temporary();
  try {
    writeFileSync(join(root, "ssh.json"), JSON.stringify([
      { id: "legacy", name: "Build box", host: "build.example.com", port: 2222, user: "dev", authMode: "agent", createdAt: 1_000 },
    ]));
    const { host, provided } = captureHost(root);
    registerPackage(host);

    const packageFile = join(root, "packages", "ssh", "ssh.json");
    assert.equal(existsSync(packageFile), true, "the legacy file moved into the package directory");
    assert.equal(existsSync(join(root, "ssh.json")), false, "the legacy file left the shared root");
    assert.deepEqual(sshService(provided).list().map((connection) => connection.id), ["legacy"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh install writes ssh.json only under the package directory", () => {
  const root = temporary();
  try {
    const { host, provided } = captureHost(root);
    registerPackage(host);
    sshService(provided).create({ host: "new.example.com", user: "dev", name: "New" });

    assert.deepEqual(readdirSync(root), ["packages"], "nothing is written to the shared root");
    assert.equal(existsSync(join(root, "packages", "ssh", "ssh.json")), true);
    assert.equal(existsSync(join(root, "ssh.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
