/**
 * Session leases on one shared runtime. A session owns a binding, never the
 * process. Failed physical teardown permanently fences the key. `force` only
 * bypasses occupancy before the first teardown attempt.
 */

export interface SharedRuntimeOccupancy {
  readonly key: string;
  snapshot(): { accepting: boolean; bindings: number; executions: number };
  acquireBinding(sessionId: string): void;
  releaseBinding(sessionId: string, options?: { abandonExecution?: boolean }): void;
  /** False when the owner is no longer accepting execution accounting. */
  beginExecution(sessionId: string): boolean;
  endExecution(sessionId: string): void;
  /** Atomically own/release a temporary binding for a utility execution. */
  beginTransientExecution(sessionId: string): boolean;
  endTransientExecution(sessionId: string): void;
}

export interface KeyedRuntimeRecord<T> {
  readonly key: string;
  readonly occupancy: SharedRuntimeOccupancy;
  readonly value: T;
}

export interface KeyedRuntimeCreated<T> {
  value: T;
  dispose: () => Promise<void>;
}

export interface KeyedRuntimeOwner<T> {
  acquire(
    key: string,
    factory: (occupancy: SharedRuntimeOccupancy) => Promise<KeyedRuntimeCreated<T>>,
  ): Promise<KeyedRuntimeRecord<T>>;
  peek(key: string): KeyedRuntimeRecord<T> | undefined;
  busy(key: string): boolean;
  dispose(key: string, options?: { force?: boolean }): Promise<void>;
  disposeAll(options?: { force?: boolean }): Promise<void>;
  settleCreates(): Promise<void>;
}

const occupancyError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

const generationFenced = (key: string): Error =>
  occupancyError(
    "unavailable",
    `runtime ${key} physical disposal failed; same-key generation is fenced`,
  );

type Occupancy = SharedRuntimeOccupancy & {
  setAccepting(value: boolean): void;
  assertIdle(force?: boolean): void;
};

export function createSharedRuntimeOccupancy(key: string, accepting = true): SharedRuntimeOccupancy {
  const bindings = new Set<string>();
  const executions = new Set<string>();
  let open = accepting;
  const occupancy: Occupancy = {
    key,
    snapshot: () => ({
      accepting: open,
      bindings: bindings.size,
      executions: executions.size,
    }),
    acquireBinding(sessionId) {
      if (bindings.has(sessionId)) return;
      if (!open) {
        throw occupancyError("unavailable", `runtime ${key} cannot accept bindings`);
      }
      bindings.add(sessionId);
    },
    releaseBinding(sessionId, options) {
      if (!bindings.has(sessionId)) return;
      if (executions.has(sessionId) && !options?.abandonExecution) {
        throw occupancyError(
          "conflict",
          `runtime ${key} still has an active execution for ${sessionId}`,
        );
      }
      if (options?.abandonExecution) executions.delete(sessionId);
      bindings.delete(sessionId);
    },
    beginExecution(sessionId) {
      if (!open) return false;
      if (!bindings.has(sessionId)) {
        throw occupancyError("unavailable", `runtime ${key} has no binding for ${sessionId}`);
      }
      executions.add(sessionId);
      return true;
    },
    endExecution(sessionId) {
      executions.delete(sessionId);
    },
    beginTransientExecution(sessionId) {
      if (!open) return false;
      bindings.add(sessionId);
      executions.add(sessionId);
      return true;
    },
    endTransientExecution(sessionId) {
      executions.delete(sessionId);
      bindings.delete(sessionId);
    },
    setAccepting(value) {
      open = value;
    },
    assertIdle(force) {
      if (force) return;
      if (bindings.size > 0 || executions.size > 0) {
        throw occupancyError(
          "conflict",
          `runtime ${key} still has ${bindings.size} binding(s) and `
            + `${executions.size} execution(s)`,
        );
      }
    },
  };
  return occupancy;
}

type Slot<T> = {
  occupancy: Occupancy;
  creation: Promise<KeyedRuntimeCreated<T>>;
  current?: KeyedRuntimeCreated<T>;
  disposal?: Promise<void>;
};

export function createKeyedRuntimeOwner<T>(): KeyedRuntimeOwner<T> {
  const slots = new Map<string, Slot<T>>();

  const acquire: KeyedRuntimeOwner<T>["acquire"] = async (key, factory) => {
    for (;;) {
      const existing = slots.get(key);
      if (existing?.disposal) {
        try {
          await existing.disposal;
        } catch {
          throw generationFenced(key);
        }
        continue;
      }
      if (existing) {
        const created = await existing.creation;
        if (existing.disposal) continue;
        return { key, occupancy: existing.occupancy, value: created.value };
      }
      const occupancy = createSharedRuntimeOccupancy(key, false) as Occupancy;
      const slot: Slot<T> = {
        occupancy,
        creation: Promise.resolve().then(() => factory(occupancy)),
      };
      slots.set(key, slot);
      try {
        const created = await slot.creation;
        if (slot.disposal) {
          await slot.disposal;
          throw occupancyError("unavailable", `runtime ${key} was disposed during creation`);
        }
        occupancy.setAccepting(true);
        slot.current = created;
        return { key, occupancy, value: created.value };
      } catch (error) {
        if (slots.get(key) === slot && !slot.disposal) slots.delete(key);
        throw error;
      }
    }
  };

  const dispose: KeyedRuntimeOwner<T>["dispose"] = async (key, options) => {
    const slot = slots.get(key);
    if (!slot) return;
    if (slot.disposal) {
      try {
        await slot.disposal;
        return;
      } catch {
        throw generationFenced(key);
      }
    }
    slot.occupancy.assertIdle(options?.force);
    slot.occupancy.setAccepting(false);
    slot.disposal = (async () => {
      const created = slot.current ?? await slot.creation.catch(() => undefined);
      if (created) await created.dispose();
      if (slots.get(key) === slot) slots.delete(key);
    })();
    return slot.disposal;
  };

  return {
    acquire,
    peek(key) {
      const slot = slots.get(key);
      if (!slot || slot.disposal || !slot.current) return undefined;
      return { key, occupancy: slot.occupancy, value: slot.current.value };
    },
    busy(key) {
      return slots.has(key);
    },
    dispose,
    async disposeAll(options) {
      await Promise.all([...slots.values()].map((slot) => slot.creation.catch(() => undefined)));
      const results = await Promise.allSettled([...slots.keys()].map((key) => dispose(key, options)));
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "runtime physical disposal failed");
    },
    settleCreates() {
      return Promise.all([...slots.values()].map((slot) => slot.creation.catch(() => undefined)))
        .then(() => undefined);
    },
  };
}
