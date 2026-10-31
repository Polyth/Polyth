import { controlError, digest } from '@polyth/control-plane';

/** Request admission, not failure-only accounting: parallel requests consume
 * their budget BEFORE expensive work. Caller supplies a trusted socket address.
 * No success resets another caller's address or installation-wide budget. */
export function createIdentityLimiter(opts: { now?: () => number; windowMs?: number; maxKeys?: number; accountLimit?: number; addressLimit?: number; globalLimit?: number } = {}) {
  const now = opts.now ?? Date.now, windowMs = opts.windowMs ?? 60_000;
  const maxKeys = opts.maxKeys ?? 4096;
  const limits = { account: opts.accountLimit ?? 10, address: opts.addressLimit ?? 40, installation: opts.globalLimit ?? 200 };
  if (maxKeys < 3 || maxKeys > 65_536 || ![windowMs, maxKeys, ...Object.values(limits)].every(n => Number.isSafeInteger(n) && n > 0)) throw controlError('invalid-input', 'Invalid identity rate limits');
  const buckets = new Map<string, { count: number; expiresAt: number }>();
  return {
    admit(address: string | undefined, account: string): void {
      const time = now();
      for (const [key, bucket] of buckets) if (bucket.expiresAt <= time) buckets.delete(key);
      const keys = [
        { key: 'installation', limit: limits.installation },
        { key: `address:${digest((address ?? 'unknown').slice(0, 200))}`, limit: limits.address },
        { key: `account:${digest(account.slice(0, 200))}`, limit: limits.account },
      ];
      const needed = keys.filter(({ key }) => !buckets.has(key)).length;
      const denied = keys.find(({ key, limit }) => (buckets.get(key)?.count ?? 0) >= limit);
      if (denied || buckets.size + needed > maxKeys) {
        const expires = denied ? buckets.get(denied.key)!.expiresAt : Math.min(...[...buckets.values()].map(b => b.expiresAt));
        throw Object.assign(controlError('rate-limited', 'Too many authentication attempts'), { retryAfterSec: Math.max(1, Math.ceil((expires - time) / 1000)) });
      }
      for (const { key } of keys) {
        const bucket = buckets.get(key) ?? { count: 0, expiresAt: time + windowMs };
        bucket.count++; buckets.set(key, bucket);
      }
    },
    size(): number { return buckets.size; },
  };
}
