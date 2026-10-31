import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('control-plane and identity workspaces are represented in the committed npm lock', () => {
  const root = new URL('../../../', import.meta.url);
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
  for (const name of ['control-plane', 'identity']) {
    const manifest = JSON.parse(readFileSync(new URL(`packages/${name}/package.json`, root), 'utf8'));
    assert.equal(lock.packages[`packages/${name}`].version, manifest.version);
    assert.equal(lock.packages[`node_modules/${manifest.name}`].resolved, `packages/${name}`);
    assert.equal(lock.packages[`node_modules/${manifest.name}`].link, true);
    assert.deepEqual(lock.packages[`packages/${name}`].dependencies ?? {}, manifest.dependencies ?? {});
  }
});
