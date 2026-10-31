export type SyncOnly<T> = [T] extends [PromiseLike<unknown>] ? never : T;

/** BEGIN IMMEDIATE + COMMIT/ROLLBACK. The callback must be synchronous: a
 *  thenable would run after COMMIT/ROLLBACK and see a different connection
 *  state. Not part of the package's public export map. */
export function withImmediateTransaction<T>(
  exec: (sql: string) => void,
  run: () => SyncOnly<T>,
): SyncOnly<T> {
  exec("BEGIN IMMEDIATE");
  try {
    const value = run();
    if (value != null && typeof (value as { then?: unknown }).then === "function") {
      throw new Error("transaction() callback must be synchronous");
    }
    exec("COMMIT");
    return value;
  } catch (err) {
    exec("ROLLBACK");
    throw err;
  }
}
