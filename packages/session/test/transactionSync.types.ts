// Compile-time contract for the production withImmediateTransaction() helper
// used by createStore. Importing it here means this file fails if the
// production signature drifts.
import { withImmediateTransaction } from "../src/syncTransaction.ts";

const synced: number = withImmediateTransaction(() => {}, () => 1);
void synced;

// @ts-expect-error async callbacks are not synchronous
withImmediateTransaction(() => {}, async () => 1);

// @ts-expect-error Promise values are not synchronous
withImmediateTransaction(() => {}, () => Promise.resolve(1));
