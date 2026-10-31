import { test } from "node:test";
import assert from "node:assert/strict";
import { withImmediateTransaction } from "../src/syncTransaction.ts";

test("transaction rolls back when the callback returns a thenable", () => {
  const ops: string[] = [];
  assert.throws(
    () => withImmediateTransaction((sql) => { ops.push(sql); }, () => Promise.resolve(1) as never),
    /must be synchronous/,
  );
  assert.deepEqual(ops, ["BEGIN IMMEDIATE", "ROLLBACK"]);
});

test("transaction commits a synchronous result", () => {
  const ops: string[] = [];
  const value = withImmediateTransaction((sql) => { ops.push(sql); }, () => 7);
  assert.equal(value, 7);
  assert.deepEqual(ops, ["BEGIN IMMEDIATE", "COMMIT"]);
});
