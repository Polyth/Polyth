// Engine compatibility for older WebViews. The native iOS app targets iOS 15,
// and older Android System WebViews lag too: a missing built-in throws during
// render, and a slot's error boundary removes the contribution silently (the
// model picker's harness tabs disappeared; a package's widgets never showed).
// This module is imported first by main.tsx so the shell and every package
// bundle that evaluates later see the shims. Each method is installed only
// when the engine lacks it, non-enumerable like the native ones.
//
// WebKit availability of everything installed here: toSorted/toReversed/
// toSpliced 16.0; at, Object.hasOwn, structuredClone and crypto.randomUUID
// 15.4; findLast/findLastIndex 15.4.

type Compare<T> = ((a: T, b: T) => number) | undefined;

const define = (name: string, value: (...args: never[]) => unknown): void => {
  if (name in Array.prototype) return;
  Object.defineProperty(Array.prototype, name, { value, writable: true, configurable: true, enumerable: false });
};

const defineOn = (target: object, name: string, value: (...args: never[]) => unknown): void => {
  if (name in target) return;
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
};

/** Install a built-in only when the engine lacks it, non-enumerable. */
const defineGlobal = (target: object, name: string, value: unknown): void => {
  if (name in target) return;
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
};

/** `at` (WebKit 15.4): package bundles call it on arrays and strings. */
function relativeIndex(length: number, index: unknown): number | undefined {
  const integer = Math.trunc(Number(index)) || 0;
  const resolved = integer < 0 ? length + integer : integer;
  return resolved < 0 || resolved >= length ? undefined : resolved;
}

export function installArrayCompat(): void {
  defineOn(Array.prototype, "at", function at<T>(this: T[], index: number): T | undefined {
    const resolved = relativeIndex(this.length, index);
    return resolved === undefined ? undefined : this[resolved];
  });
  defineOn(String.prototype, "at", function at(this: string, index: number): string | undefined {
    const text = String(this);
    const resolved = relativeIndex(text.length, index);
    return resolved === undefined ? undefined : text[resolved];
  });
  define("toSorted", function toSorted<T>(this: T[], compare?: Compare<T>): T[] {
    return Array.prototype.slice.call(this).sort(compare);
  });
  define("toReversed", function toReversed<T>(this: T[]): T[] {
    return Array.prototype.slice.call(this).reverse();
  });
  define("toSpliced", function toSpliced<T>(this: T[], ...args: [number, number?, ...T[]]): T[] {
    const copy: T[] = Array.prototype.slice.call(this);
    if (args.length > 0) Array.prototype.splice.apply(copy, args as [number, number, ...T[]]);
    return copy;
  });
  define("findLastIndex", function findLastIndex<T>(this: T[], predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown): number {
    for (let index = this.length - 1; index >= 0; index -= 1) {
      if (predicate.call(thisArg, this[index]!, index, this)) return index;
    }
    return -1;
  });
  define("findLast", function findLast<T>(this: T[], predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown): T | undefined {
    for (let index = this.length - 1; index >= 0; index -= 1) {
      if (predicate.call(thisArg, this[index]!, index, this)) return this[index];
    }
    return undefined;
  });
}

/** `Object.hasOwn` (WebKit 15.4). Shell code (`execution.ts`,
 *  `presentationMerge.ts`) calls it unguarded. */
export function installObjectCompat(): void {
  defineGlobal(Object, "hasOwn", function hasOwn(target: object, key: PropertyKey): boolean {
    if (target === null || target === undefined) {
      throw new TypeError("Cannot convert undefined or null to object");
    }
    return Object.prototype.hasOwnProperty.call(Object(target), key);
  });
}

/** Structural clone covering the shapes browser/package code clones: arrays,
 *  plain objects, Date, RegExp, Map, Set and buffers. Functions and symbols
 *  throw like the native DataCloneError. */
function cloneValue(value: unknown, seen: Map<unknown, unknown>): unknown {
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("structuredClone: value could not be cloned");
  }
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) {
    const clone = new RegExp(value.source, value.flags);
    clone.lastIndex = value.lastIndex;
    return clone;
  }
  if (value instanceof Map) {
    const clone = new Map<unknown, unknown>();
    seen.set(value, clone);
    for (const [key, item] of value) clone.set(cloneValue(key, seen), cloneValue(item, seen));
    return clone;
  }
  if (value instanceof Set) {
    const clone = new Set<unknown>();
    seen.set(value, clone);
    for (const item of value) clone.add(cloneValue(item, seen));
    return clone;
  }
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      return new DataView(value.buffer.slice(0), value.byteOffset, value.byteLength);
    }
    return (value as unknown as { slice(): unknown }).slice();
  }
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(cloneValue(item, seen));
    return clone;
  }
  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) clone[key] = cloneValue(item, seen);
  return clone;
}

/** `structuredClone` (WebKit 15.4). Shell contribution-relevance code and
 *  workflow/judgment widgets clone composition objects unguarded. */
export function installStructuredClone(): void {
  defineGlobal(globalThis, "structuredClone", function structuredClone<T>(value: T): T {
    return cloneValue(value, new Map()) as T;
  });
}

/** `crypto.randomUUID` (WebKit 15.4). `mutationIntent.ts` and sandboxed
 *  contributions call it without a feature check. */
export function installCryptoCompat(): void {
  const cryptoObject = (globalThis as { crypto?: Crypto }).crypto;
  if (!cryptoObject || typeof cryptoObject.randomUUID === "function") return;
  const getRandomValues = cryptoObject.getRandomValues?.bind(cryptoObject);
  if (typeof getRandomValues !== "function") return;
  defineGlobal(Object.getPrototypeOf(cryptoObject) as object, "randomUUID", function randomUUID(): string {
    const bytes = getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  });
}

installArrayCompat();
installObjectCompat();
installStructuredClone();
installCryptoCompat();
