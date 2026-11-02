// Seeded, dependency-free generator of adversarial strings for the fuzz tests.
// POLYTH_FUZZ_SEED reproduces a run; POLYTH_FUZZ_RUNS scales the iteration count.
import assert from "node:assert/strict";

export const FUZZ_SEED = Number(process.env.POLYTH_FUZZ_SEED ?? 0x5eed1234) >>> 0;
export const FUZZ_RUNS = Number(process.env.POLYTH_FUZZ_RUNS ?? 300);

export const BASE_TOKENS: readonly string[] = [
  "<", ">", "</", "<!--", "-->", "\"", "'", "=", "&amp;", "&", ";", "|", "\\", "`", "```", "*", "_", "#", "/",
  "\t", " ", "\n", "\r", "\r\n", "\0", "é", "‮", "😀", "\ud800", "​", "＜", "[", "]", "(", ")", "{", "}", ":", "-",
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One adversarial string: token soup, long single-token runs and raw code points. */
function randomInput(rand: () => number, tokens: readonly string[]): string {
  const pick = () => tokens[Math.floor(rand() * tokens.length)]!;
  const parts = 1 + Math.floor(rand() * 24);
  let out = "";
  for (let i = 0; i < parts; i++) {
    const kind = rand();
    if (kind < 0.7) out += pick();
    else if (kind < 0.8) out += pick().repeat(1 + Math.floor(rand() * 200));
    else if (kind < 0.9) out += String.fromCodePoint(Math.floor(rand() * 0x110000) % 0xd800 + (rand() < 0.5 ? 0 : 0xe000));
    else out += "abc xyz 123".slice(0, 1 + Math.floor(rand() * 11));
  }
  return out;
}

export function* fuzzInputs(extraTokens: readonly string[] = [], runs = FUZZ_RUNS): Generator<string> {
  const rand = mulberry32(FUZZ_SEED);
  const tokens = [...BASE_TOKENS, ...extraTokens];
  for (let i = 0; i < runs; i++) yield randomInput(rand, tokens);
}

export function describeInput(input: unknown): string {
  const text = JSON.stringify(input) ?? String(input);
  return `seed=${FUZZ_SEED} input=${text.length > 400 ? `${text.slice(0, 400)}…(${text.length} chars)` : text}`;
}

/** Runs `check` on every generated input; a failure names the seed and input. */
export function forEachFuzzInput(extraTokens: readonly string[], check: (input: string) => void): void {
  for (const input of fuzzInputs(extraTokens)) {
    try {
      check(input);
    } catch (error) {
      assert.fail(`${error instanceof Error ? error.message : String(error)} :: ${describeInput(input)}`);
    }
  }
}

/** Every special token repeated `reps` times must be processed within `limitMs`. */
export function assertBoundedTime(
  extraTokens: readonly string[],
  run: (input: string) => unknown,
  { reps = 50_000, limitMs = 200, skip = [] }: { reps?: number; limitMs?: number; skip?: readonly string[] } = {},
): void {
  for (const token of [...BASE_TOKENS, ...extraTokens].filter((candidate) => !skip.includes(candidate))) {
    const input = token.repeat(reps);
    const started = performance.now();
    run(input);
    const took = performance.now() - started;
    assert.ok(took < limitMs, `${JSON.stringify(token)} x${reps} took ${took.toFixed(0)} ms (limit ${limitMs}); seed=${FUZZ_SEED}`);
  }
}
