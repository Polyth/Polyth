import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openControlPlane } from '@polyth/control-plane';
import { createIdentityService, type PasswordService } from '../src/index.ts';

// Transaction tests deliberately inject a non-production verifier. The real
// asynchronous scrypt implementation has separate crypto/worker-bound tests.
export const testPasswords = (): PasswordService => ({
  async hash(password) { return `test-only:${password}`; },
  async verify(password, encoded) { return { valid: encoded === `test-only:${password}` || encoded === `legacy-only:${password}`, needsRehash: encoded?.startsWith('legacy-only:') ?? false }; },
  close() {},
});
export function fixture(t: TestContext, options: { passwords?: PasswordService; idleMs?: number; absoluteMs?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'polyth-identity-'));
  const control = openControlPlane({ directory });
  let clock = 1_800_000_000_000;
  const passwords = options.passwords ?? testPasswords();
  const identity = createIdentityService(control, { passwords, now: () => clock, idleMs: options.idleMs, absoluteMs: options.absoluteMs });
  t.after(() => { identity.close(); control.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, control, identity, now: () => clock, advance: (ms: number) => { clock += ms; } };
}
export function prepared(f: ReturnType<typeof fixture>) {
  const claim = f.identity.setup.issueClaim(), binding = 'ab'.repeat(32);
  f.identity.setup.bindClaim(claim.token, binding);
  const recovery = f.identity.setup.prepareRecovery(claim.token, binding);
  return { claim, binding, recovery, input: {
    claimToken: claim.token, browserBinding: binding, name: 'Max', organizationName: 'Home',
    login: 'Max', password: 'owner test passphrase', recoverySetId: recovery.setId, recoveryAcknowledged: true,
  } };
}
export async function installed(f: ReturnType<typeof fixture>) {
  const prep = prepared(f);
  return { ...prep, owner: await f.identity.setup.complete(prep.input) };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
