/** Tiny request-admission/drain primitive. Not a generic request framework. */

const shuttingDown = Object.assign(new Error("server shutting down"), { code: "unavailable" });

export function createHttpAdmission() {
  let phase: "open" | "stopping" | "fenced" = "open";
  let active = 0;
  const waiters = new Set<() => void>();

  const notifyIdle = (): void => {
    if (active !== 0) return;
    for (const waiter of waiters) waiter();
    waiters.clear();
  };

  return {
    enter(): boolean {
      if (phase !== "open") return false;
      active += 1;
      return true;
    },
    leave(): void {
      if (active > 0) active -= 1;
      notifyIdle();
    },
    stop(): void {
      if (phase === "open") phase = "stopping";
    },
    fence(): void {
      phase = "fenced";
    },
    isFenced(): boolean {
      return phase === "fenced";
    },
    assertLive(): void {
      if (phase === "fenced") throw shuttingDown;
    },
    activeCount(): number {
      return active;
    },
    waitIdle(timeoutMs: number): Promise<boolean> {
      if (active === 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          waiters.delete(onIdle);
          clearTimeout(timer);
          resolve(ok);
        };
        const onIdle = () => finish(true);
        waiters.add(onIdle);
        const timer = setTimeout(() => finish(false), timeoutMs);
      });
    },
  };
}

export type HttpAdmission = ReturnType<typeof createHttpAdmission>;
