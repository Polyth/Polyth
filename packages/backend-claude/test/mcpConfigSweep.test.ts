import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sweepStaleClaudeMcpConfigFiles } from "../src/provisioner.ts";

test("stale MCP config files from before this server started are swept once; live and foreign files stay", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-mcp-configs-"));
  try {
    const stale = join(root, "11111111-1111-4111-8111-111111111111.json");
    const fresh = join(root, "22222222-2222-4222-8222-222222222222.json");
    const foreign = join(root, "notes.json");
    const linked = join(root, "33333333-3333-4333-8333-333333333333.json");
    await writeFile(stale, "{}");
    await writeFile(fresh, "{}");
    await writeFile(foreign, "{}");
    await symlink(fresh, linked);
    const twoHoursAgo = (Date.now() - 2 * 60 * 60_000) / 1000;
    await utimes(stale, twoHoursAgo, twoHoursAgo);
    await utimes(foreign, twoHoursAgo, twoHoursAgo);

    assert.equal(sweepStaleClaudeMcpConfigFiles(root), 1);
    assert.deepEqual((await readdir(root)).sort(), [
      "22222222-2222-4222-8222-222222222222.json",
      "33333333-3333-4333-8333-333333333333.json",
      "notes.json",
    ]);
    // Once per root per process: a later spawn does not rescan the directory.
    await utimes(fresh, twoHoursAgo, twoHoursAgo);
    assert.equal(sweepStaleClaudeMcpConfigFiles(root), 0);
    assert.equal(sweepStaleClaudeMcpConfigFiles(join(root, "missing")), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
