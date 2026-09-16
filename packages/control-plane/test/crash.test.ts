import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openControlPlane } from '../src/index.ts';

const run = promisify(execFile);
test('process death inside a write transaction leaves no owner, audit, outbox or epoch fragment', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'polyth-control-crash-'));
  let control = openControlPlane({ directory });
  const id = control.installation().id;
  control.close();
  t.after(() => { control.close(); rmSync(directory, { recursive: true, force: true }); });
  const source = `
    import { openControlPlane } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
    const c = openControlPlane({ directory: ${JSON.stringify(directory)} });
    c.transaction(() => {
      c.run("INSERT INTO principals(id,kind,status) VALUES('usr_partial','user','active')");
      c.bumpEpoch(); c.audit('system:test','partial-write');
      process.kill(process.pid, 'SIGKILL');
    });
  `;
  await assert.rejects(run(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], { timeout: 10_000 }), (e: any) => e.signal === 'SIGKILL');
  control = openControlPlane({ directory });
  assert.equal(control.installation().id, id);
  assert.equal(control.installation().authority_epoch, 1);
  for (const table of ['principals', 'audit_events', 'outbox']) assert.equal(control.all(`SELECT * FROM ${table}`).length, 0);
  assert.deepEqual(control.all('PRAGMA foreign_key_check'), []);
});
