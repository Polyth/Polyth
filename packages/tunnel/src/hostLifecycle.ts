import type { LinkHostClient } from "./host.ts";

/** Own one host generation at a time. Recovery never retries a caller's RPC. */
export function createLinkHostLifecycle(deps: {
  start(): Promise<LinkHostClient>;
  initialize(host: LinkHostClient): Promise<void>;
  release(host: LinkHostClient): Promise<void>;
  changed(): void;
  failed(error: unknown): void;
  checkIntervalMs?: number;
}) {
  let enabled = false;
  let current: LinkHostClient | null = null;
  let ready = false;
  let pending: Promise<LinkHostClient | null> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let retryAt = 0;
  const interval = deps.checkIntervalMs ?? 5_000;

  const schedule = () => {
    clearTimeout(timer);
    if (!enabled) return;
    timer = setTimeout(() => void check(), Math.max(interval, retryAt - Date.now()));
    timer.unref();
  };

  const ensure = (): Promise<LinkHostClient | null> => {
    if (!enabled) return Promise.resolve(null);
    if (pending) return pending;
    if (ready && current?.available) return Promise.resolve(current);
    if (Date.now() < retryAt) return Promise.resolve(null);
    pending = (async () => {
      ready = false;
      deps.changed();
      try {
        if (current) {
          // Keep the old authority if release cannot be proven. Never launch
          // another host onto its control socket or ingress in that case.
          await deps.release(current);
          current = null;
        }
        if (!enabled) return null;
        current = await deps.start();
        if (!current.available) throw Object.assign(new Error("Polyth Link host is unavailable"), { code: current.lastErrorCode });
        if (!enabled) return null;
        await deps.initialize(current);
        if (!enabled || !current.available) return null;
        ready = true;
        failures = 0;
        retryAt = 0;
        return current;
      } catch (error) {
        failures += 1;
        retryAt = Date.now() + Math.min(30_000, interval * 2 ** Math.min(failures - 1, 4));
        deps.failed(error);
        return null;
      } finally {
        deps.changed();
      }
    })().finally(() => {
      pending = null;
      schedule();
    });
    return pending;
  };

  const check = async () => {
    timer = undefined;
    if (!enabled) return;
    const activeHost = current;
    if (ready && activeHost?.available) {
      try { await activeHost.request("identity.status"); }
      catch (error) {
        if (!enabled || current !== activeHost) return;
        if (!activeHost.available) {
          ready = false;
          deps.changed();
        } else {
          // A normal RPC error is evidence of a responding process, not death.
          deps.failed(error);
        }
      }
      if (!enabled || current !== activeHost) return;
    }
    await ensure();
    schedule();
  };

  const stop = () => {
    enabled = false;
    ready = false;
    clearTimeout(timer);
  };

  return {
    get host() { return current; },
    get ready() { return ready && Boolean(current?.available); },
    ensure,
    stop,
    async enable() {
      enabled = true;
      retryAt = 0;
      failures = 0;
      await ensure();
    },
    async disable() {
      stop();
      await pending;
      if (current) {
        await deps.release(current);
        current = null;
      }
      deps.changed();
    },
  };
}
