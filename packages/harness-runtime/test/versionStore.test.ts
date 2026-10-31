import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import type { HarnessVersionStore } from "@polyth/contracts";
import { runHarnessUpdate } from "../src/serverEntry.ts";
import { pruneHarnessVersions } from "../src/versionStore.ts";

const store: HarnessVersionStore = {
    directory: (path) => basename(dirname(path)) === "versions" ? dirname(path) : undefined,
    entry: /^[0-9]+\.[0-9]+\.[0-9]+$/,
};

function fixture(t: { after(fn: () => void): void }) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-versions-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const versions = join(root, "versions");
    mkdirSync(versions);
    for (const name of ["0.9.0", "1.0.0", "1.0.1", "1.0.2", "1.0.3.partial"]) writeFileSync(join(versions, name), name);
    mkdirSync(join(versions, "1.1.0"));
    symlinkSync(join(versions, "1.0.0"), join(versions, "2.0.0"));
    const proc = join(root, "proc");
    mkdirSync(join(proc, "100"), { recursive: true });
    symlinkSync(join(versions, "1.0.1"), join(proc, "100", "exe"));
    mkdirSync(join(proc, "101"));
    writeFileSync(join(proc, "101", "cmdline"), ["node", join(versions, "0.9.0"), "--flag"].join("\0"));
    mkdirSync(join(proc, "self"));
    return { versions, proc };
}

test("pruning keeps the active version and every version a process runs or names", async (t) => {
    const { versions, proc } = fixture(t);
    const result = await pruneHarnessVersions(store, join(versions, "1.0.2"), { platform: "linux", procRoot: proc });
    assert.deepEqual(result, { pruned: true, active: "1.0.2", removed: ["1.0.0", "1.1.0"], kept: ["0.9.0", "1.0.1", "2.0.0"] });
    assert.deepEqual(readdirSync(versions).sort(), ["0.9.0", "1.0.1", "1.0.2", "1.0.3.partial", "2.0.0"]);
});

test("pruning removes nothing when use or layout cannot be established", async (t) => {
    const { versions, proc } = fixture(t);
    const before = readdirSync(versions).sort();
    assert.deepEqual(await pruneHarnessVersions(store, join(versions, "1.0.2"), { platform: "darwin", procRoot: proc }),
        { pruned: false, reason: "running versions cannot be listed on this platform" });
    assert.deepEqual(await pruneHarnessVersions(store, join(versions, "1.0.2"), { platform: "linux", procRoot: join(proc, "missing") }),
        { pruned: false, reason: "running processes cannot be listed" });
    assert.equal((await pruneHarnessVersions(store, join(dirname(versions), "npm", "cli.js"), { platform: "linux", procRoot: proc })).pruned, false);
    assert.equal((await pruneHarnessVersions(store, join(versions, "1.0.3.partial"), { platform: "linux", procRoot: proc })).pruned, false);
    assert.deepEqual(readdirSync(versions).sort(), before);
});

test("a successful update prunes the versions it superseded; a failed one prunes nothing", { skip: process.platform !== "linux" }, async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-update-versions-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const versions = join(root, "versions");
    mkdirSync(versions);
    const launcher = join(root, "fake-cli");
    // Each version is the CLI itself; `update ok` installs 1.0.2 beside it and
    // repoints the launcher, as a side-by-side self-updater does.
    const script = `#!/bin/sh\n[ "$2" = ok ] || exit 3\ncp "$0" "${versions}/1.0.2"\nln -sfn "${versions}/1.0.2" "${launcher}"\necho updated\n`;
    for (const name of ["1.0.0", "1.0.1"]) {
        writeFileSync(join(versions, name), script);
        chmodSync(join(versions, name), 0o755);
    }
    symlinkSync(join(versions, "1.0.1"), launcher);

    const failed = await runHarnessUpdate([launcher, "update", "no"], store);
    assert.equal(failed.ok, false);
    assert.equal(failed.versions, undefined);
    assert.equal(existsSync(join(versions, "1.0.0")), true);

    const result = await runHarnessUpdate([launcher, "update", "ok"], store);
    assert.equal(result.ok, true);
    assert.deepEqual(result.versions, { pruned: true, active: "1.0.2", removed: ["1.0.0", "1.0.1"], kept: [] });
    assert.equal(result.output, "updated\nRemoved old versions: 1.0.0, 1.0.1");
    assert.deepEqual(readdirSync(versions), ["1.0.2"]);
});
