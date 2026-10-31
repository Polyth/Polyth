import test from "node:test";
import assert from "node:assert/strict";
import { setLocale } from "../src/i18n/index.ts";
import { fmtTokens } from "../src/format.ts";

test("token counts are exact below a thousand and gain one decimal per unit", () => {
  assert.equal(fmtTokens(0), "0");
  assert.equal(fmtTokens(999), "999");
  assert.equal(fmtTokens(1_000), "1.0k");
  assert.equal(fmtTokens(42_000), "42.0k");
  assert.equal(fmtTokens(1_000_000), "1.0M");
  assert.equal(fmtTokens(11_500_000), "11.5M");
  assert.equal(fmtTokens(842_300_000), "842.3M");
});

test("a count of a thousand million or more reads in billions", () => {
  assert.equal(fmtTokens(1_000_000_000), "1.0B");
  assert.equal(fmtTokens(1_234_567_890), "1.2B");
  assert.equal(fmtTokens(12_345_678_901), "12.3B");
  assert.equal(fmtTokens(123_456_789_012), "123.5B");
});

test("a figure that would round up to 1,000.0 moves to the next unit", () => {
  assert.equal(fmtTokens(999_949), "999.9k");
  assert.equal(fmtTokens(999_950), "1.0M");
  assert.equal(fmtTokens(999_999), "1.0M");
  assert.equal(fmtTokens(999_949_999), "999.9M");
  assert.equal(fmtTokens(999_950_000), "1.0B");
  assert.equal(fmtTokens(999_999_999), "1.0B");
});

test("values below the first unit render plainly instead of being abbreviated", () => {
  assert.equal(fmtTokens(-5), "-5");
  assert.equal(fmtTokens(-5_000_000_000), "-5,000,000,000");
});

test("billions follow the locale's decimal separator and keep the B suffix", async () => {
  await setLocale("uk");
  try {
    assert.equal(fmtTokens(11_500_000), "11,5M");
    assert.equal(fmtTokens(12_345_678_901), "12,3B");
  } finally {
    await setLocale("en");
  }
});
