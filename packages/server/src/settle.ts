/**
 * Preserve a critical section until every concurrently-started operation has
 * settled, while still propagating the first failure to the caller.
 */
export async function settleAllOrThrow<T>(
  operations: Iterable<PromiseLike<T>>,
): Promise<T[]> {
  const settled = await Promise.allSettled(operations);
  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
}
