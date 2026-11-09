/** Small owned SemVer 2.0.0 subset.
 *
 * Behaviour follows node-semver 7 (strict mode) for the range forms Polyth
 * accepts: exact versions, comparators, `^`, `~`, x-ranges, hyphen ranges,
 * space-separated AND sets and `||` OR sets. It intentionally does not
 * support `!=`, loose parsing, coercion, `minVersion`/`outside` helpers or
 * tag/index range arguments.
 *
 * The version and range grammar and the range desugaring rules are adapted
 * from node-semver (https://github.com/npm/node-semver), used under the ISC
 * licence:
 *
 *   Copyright (c) Isaac Z. Schlueter and Contributors
 *
 *   Permission to use, copy, modify, and/or distribute this software for any
 *   purpose with or without fee is hereby granted, provided that the above
 *   copyright notice and this permission notice appear in all copies.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 *   WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 *   MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 *   ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 *   WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 *   ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 *   OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

type PrereleaseIdentifier = string | number;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: PrereleaseIdentifier[];
  version: string;
}

const MAX_LENGTH = 256;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

const NUMERIC_IDENTIFIER = "0|[1-9]\\d*";
const NONNUMERIC_IDENTIFIER = "\\d*[a-zA-Z-][a-zA-Z0-9-]*";
const MAIN_VERSION = `(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})`;
const PRERELEASE_IDENTIFIER = `(?:${NONNUMERIC_IDENTIFIER}|${NUMERIC_IDENTIFIER})`;
const PRERELEASE = `(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))`;
const BUILD_IDENTIFIER = "[a-zA-Z0-9-]+";
const BUILD = `(?:\\+(${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*))`;
const FULL_PLAIN = `v?${MAIN_VERSION}${PRERELEASE}?${BUILD}?`;
const XRANGE_IDENTIFIER = `${NUMERIC_IDENTIFIER}|x|X|\\*`;
const XRANGE_PLAIN =
  `[v=\\s]*(${XRANGE_IDENTIFIER})(?:\\.(${XRANGE_IDENTIFIER})(?:\\.(${XRANGE_IDENTIFIER})${PRERELEASE}?${BUILD}?)?)?`;
const GTLT = "((?:<|>)?=?)";

const FULL = new RegExp(`^${FULL_PLAIN}$`);
const XRANGE = new RegExp(`^${GTLT}\\s*${XRANGE_PLAIN}$`);
const TILDE = new RegExp(`^~>?${XRANGE_PLAIN}$`);
const CARET = new RegExp(`^\\^${XRANGE_PLAIN}$`);
const COMPARATOR = new RegExp(`^${GTLT}\\s*(${FULL_PLAIN})$|^$`);
const COMPARATOR_TRIM = new RegExp(`(\\s*)${GTLT}\\s*(${XRANGE_PLAIN})`, "g");
const TILDE_TRIM = /(\s*)(?:~>?)\s+/g;
const CARET_TRIM = /(\s*)\^\s+/g;
const HYPHEN_RANGE = new RegExp(`^\\s*(${XRANGE_PLAIN})\\s+-\\s+(${XRANGE_PLAIN})\\s*$`);
const BUILD_STRIP = new RegExp(BUILD, "g");
const STAR = /(<|>)?=?\s*\*/g;
const GTE0 = /^\s*>=\s*0\.0\.0\s*$/;
const GTE0_PRE = /^\s*>=\s*0\.0\.0-0\s*$/;

const NUMERIC = /^[0-9]+$/;

function isX(id: string | undefined): boolean {
  return !id || id.toLowerCase() === "x" || id === "*";
}

function parseVersion(input: string): ParsedVersion | null {
  if (typeof input !== "string" || input.length > MAX_LENGTH) return null;
  const match = input.trim().match(FULL);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major > MAX_SAFE_INTEGER || minor > MAX_SAFE_INTEGER || patch > MAX_SAFE_INTEGER) return null;
  const prerelease: PrereleaseIdentifier[] = match[4]
    ? match[4].split(".").map((id) => {
        if (NUMERIC.test(id)) {
          const num = Number(id);
          if (num >= 0 && num < MAX_SAFE_INTEGER) return num;
        }
        return id;
      })
    : [];
  let version = `${major}.${minor}.${patch}`;
  if (prerelease.length) version += `-${prerelease.join(".")}`;
  return { major, minor, patch, prerelease, version };
}

function requireVersion(input: string): ParsedVersion {
  const parsed = parseVersion(input);
  if (!parsed) throw new TypeError(`Invalid Version: ${input}`);
  return parsed;
}

function compareIdentifiers(a: PrereleaseIdentifier, b: PrereleaseIdentifier): -1 | 0 | 1 {
  const anum = NUMERIC.test(String(a));
  const bnum = NUMERIC.test(String(b));
  if (anum && bnum) {
    const an = Number(a);
    const bn = Number(b);
    return an === bn ? 0 : an < bn ? -1 : 1;
  }
  if (anum && !bnum) return -1;
  if (bnum && !anum) return 1;
  const as = String(a);
  const bs = String(b);
  return as === bs ? 0 : as < bs ? -1 : 1;
}

function compareParsed(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease.length && !b.prerelease.length) return -1;
  if (!a.prerelease.length && b.prerelease.length) return 1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const result = compareIdentifiers(left, right);
    if (result !== 0) return result;
  }
  return 0;
}

/** Strict SemVer validation; returns the normalized version or null.
 *  Like node-semver, optional leading `v` is accepted, build metadata is
 *  dropped from the returned value and a leading `=` is not accepted. */
export function valid(version: string): string | null {
  return parseVersion(version)?.version ?? null;
}

/** Full SemVer 2.0.0 precedence comparison; build metadata is ignored.
 *  Throws a TypeError when either side is not a valid version. */
export function compare(a: string, b: string): -1 | 0 | 1 {
  return compareParsed(requireVersion(a), requireVersion(b));
}

export function gt(a: string, b: string): boolean {
  return compare(a, b) > 0;
}

interface Comparator {
  /** Empty string for "any version". */
  value: string;
  any: boolean;
  operator: "" | ">" | ">=" | "<" | "<=";
  semver: ParsedVersion | null;
}

const ANY_COMPARATOR: Comparator = { value: "", any: true, operator: "", semver: null };

function parseComparator(input: string): Comparator {
  const match = input.trim().split(/\s+/).join(" ").match(COMPARATOR);
  if (!match) throw new TypeError(`Invalid comparator: ${input}`);
  const rawOperator = match[1] !== undefined ? match[1] : "";
  const operator = rawOperator === "=" ? "" : rawOperator;
  if (!match[2]) return ANY_COMPARATOR;
  const semver = parseVersion(match[2]);
  if (!semver) throw new TypeError(`Invalid comparator: ${input}`);
  return {
    value: `${operator}${semver.version}`,
    any: false,
    operator: operator as Comparator["operator"],
    semver,
  };
}

function isNullSet(comparator: Comparator): boolean {
  return comparator.value === "<0.0.0-0";
}

function replaceGteZero(comparator: string, includePrerelease: boolean): string {
  return comparator.trim().replace(includePrerelease ? GTE0_PRE : GTE0, "");
}

function replaceTilde(comparator: string, includePrerelease: boolean): string {
  const z = includePrerelease ? "-0" : "";
  return comparator.replace(TILDE, (_match, M: string, m: string, p: string, prerelease: string) => {
    if (isX(M)) return "";
    if (isX(m)) return `>=${M}.0.0${z} <${Number(M) + 1}.0.0-0`;
    if (isX(p)) return `>=${M}.${m}.0${z} <${M}.${Number(m) + 1}.0-0`;
    if (prerelease) return `>=${M}.${m}.${p}-${prerelease} <${M}.${Number(m) + 1}.0-0`;
    return `>=${M}.${m}.${p} <${M}.${Number(m) + 1}.0-0`;
  });
}

function replaceCaret(comparator: string, includePrerelease: boolean): string {
  const z = includePrerelease ? "-0" : "";
  return comparator.replace(CARET, (_match, M: string, m: string, p: string, prerelease: string) => {
    if (isX(M)) return "";
    if (isX(m)) return `>=${M}.0.0${z} <${Number(M) + 1}.0.0-0`;
    if (isX(p)) {
      return M === "0"
        ? `>=${M}.${m}.0${z} <${M}.${Number(m) + 1}.0-0`
        : `>=${M}.${m}.0${z} <${Number(M) + 1}.0.0-0`;
    }
    if (prerelease) {
      if (M === "0") {
        return m === "0"
          ? `>=${M}.${m}.${p}-${prerelease} <${M}.${m}.${Number(p) + 1}-0`
          : `>=${M}.${m}.${p}-${prerelease} <${M}.${Number(m) + 1}.0-0`;
      }
      return `>=${M}.${m}.${p}-${prerelease} <${Number(M) + 1}.0.0-0`;
    }
    if (M === "0") {
      return m === "0"
        ? `>=${M}.${m}.${p} <${M}.${m}.${Number(p) + 1}-0`
        : `>=${M}.${m}.${p} <${M}.${Number(m) + 1}.0-0`;
    }
    return `>=${M}.${m}.${p} <${Number(M) + 1}.0.0-0`;
  });
}

function invalidXRangeOrder(M: string | undefined, m: string | undefined, p: string | undefined): boolean {
  return (isX(M) && !isX(m)) || (isX(m) && Boolean(p) && !isX(p));
}

function replaceXRange(comparator: string, includePrerelease: boolean): string {
  const input = comparator.trim();
  return input.replace(
    XRANGE,
    (original: string, rawOperator: string, M: string, m: string, p: string) => {
      if (invalidXRangeOrder(M, m, p)) return original;
      let operator = rawOperator;
      const xM = isX(M);
      const xm = xM || isX(m);
      const xp = xm || isX(p);
      const anyX = xp;
      if (operator === "=" && anyX) operator = "";
      let prerelease = includePrerelease ? "-0" : "";
      if (xM) {
        return operator === ">" || operator === "<" ? "<0.0.0-0" : "*";
      }
      if (operator && anyX) {
        if (xm) m = "0";
        p = "0";
        if (operator === ">") {
          operator = ">=";
          if (xm) {
            M = String(Number(M) + 1);
            m = "0";
            p = "0";
          } else {
            m = String(Number(m) + 1);
            p = "0";
          }
        } else if (operator === "<=") {
          operator = "<";
          if (xm) M = String(Number(M) + 1);
          else m = String(Number(m) + 1);
        }
        if (operator === "<") prerelease = "-0";
        return `${operator}${M}.${m}.${p}${prerelease}`;
      }
      if (xm) return `>=${M}.0.0${prerelease} <${Number(M) + 1}.0.0-0`;
      if (xp) return `>=${M}.${m}.0${prerelease} <${M}.${Number(m) + 1}.0-0`;
      return original;
    },
  );
}

function replaceCarets(input: string, includePrerelease: boolean): string {
  return input.trim().split(/\s+/).map((part) => replaceCaret(part, includePrerelease)).join(" ");
}

function replaceTildes(input: string, includePrerelease: boolean): string {
  return input.trim().split(/\s+/).map((part) => replaceTilde(part, includePrerelease)).join(" ");
}

function replaceXRanges(input: string, includePrerelease: boolean): string {
  return input.split(/\s+/).map((part) => replaceXRange(part, includePrerelease)).join(" ");
}

function replaceStars(input: string): string {
  return input.trim().replace(STAR, "");
}

function hyphenReplace(includePrerelease: boolean) {
  return (
    _match: string,
    from: string,
    fM: string,
    fm: string,
    fp: string,
    fpr: string,
    _fb: string,
    to: string,
    tM: string,
    tm: string,
    tp: string,
    tpr: string,
  ): string => {
    if (isX(fM)) from = "";
    else if (isX(fm)) from = `>=${fM}.0.0${includePrerelease ? "-0" : ""}`;
    else if (isX(fp)) from = `>=${fM}.${fm}.0${includePrerelease ? "-0" : ""}`;
    else if (fpr) from = `>=${from}`;
    else from = `>=${from}${includePrerelease ? "-0" : ""}`;

    if (isX(tM)) to = "";
    else if (isX(tm)) to = `<${Number(tM) + 1}.0.0-0`;
    else if (isX(tp)) to = `<${tM}.${Number(tm) + 1}.0-0`;
    else if (tpr) to = `<=${tM}.${tm}.${tp}-${tpr}`;
    else if (includePrerelease) to = `<${tM}.${tm}.${Number(tp) + 1}-0`;
    else to = `<=${to}`;

    return `${from} ${to}`.trim();
  };
}

function parseComparatorToken(token: string, includePrerelease: boolean): string {
  let value = token.replace(BUILD, "");
  value = replaceCarets(value, includePrerelease);
  value = replaceTildes(value, includePrerelease);
  value = replaceXRanges(value, includePrerelease);
  return replaceStars(value);
}

type ComparatorSet = Comparator[];

function parseComparatorSet(input: string, includePrerelease: boolean): ComparatorSet {
  let range = input.replace(BUILD_STRIP, "");
  range = range.replace(HYPHEN_RANGE, hyphenReplace(includePrerelease));
  range = range.replace(COMPARATOR_TRIM, "$1$2$3");
  range = range.replace(TILDE_TRIM, "$1~");
  range = range.replace(CARET_TRIM, "$1^");

  const tokens = range
    .split(" ")
    .map((token) => parseComparatorToken(token, includePrerelease))
    .join(" ")
    .split(/\s+/)
    .map((token) => replaceGteZero(token, includePrerelease));

  const comparators = tokens.map(parseComparator);
  const byValue = new Map<string, Comparator>();
  for (const comparator of comparators) {
    if (isNullSet(comparator)) return [comparator];
    byValue.set(comparator.value, comparator);
  }
  if (byValue.size > 1 && byValue.has("")) byValue.delete("");
  return [...byValue.values()];
}

function parseRange(input: string, includePrerelease: boolean): ComparatorSet[] {
  const raw = input.trim().replace(/\s+/g, " ");
  const sets = raw.split("||").map((part) => parseComparatorSet(part.trim(), includePrerelease));
  if (!sets.length) throw new TypeError(`Invalid SemVer Range: ${raw}`);
  if (sets.length > 1) {
    const first = sets[0] as ComparatorSet;
    let nonNull = sets.filter((set) => !isNullSet(set[0] as Comparator));
    if (nonNull.length === 0) nonNull = [first];
    if (nonNull.length > 1) {
      const any = nonNull.find((set) => set.length === 1 && set[0]?.value === "");
      if (any) nonNull = [any];
    }
    return nonNull;
  }
  return sets;
}

function testComparator(comparator: Comparator, version: ParsedVersion): boolean {
  if (comparator.any || !comparator.semver) return true;
  const result = compareParsed(version, comparator.semver);
  switch (comparator.operator) {
    case "":
      return result === 0;
    case ">":
      return result > 0;
    case ">=":
      return result >= 0;
    case "<":
      return result < 0;
    case "<=":
      return result <= 0;
  }
}

function testSet(set: ComparatorSet, version: ParsedVersion, includePrerelease: boolean): boolean {
  for (const comparator of set) {
    if (!testComparator(comparator, version)) return false;
  }
  if (version.prerelease.length && !includePrerelease) {
    for (const comparator of set) {
      if (comparator.any || !comparator.semver) continue;
      if (comparator.semver.prerelease.length > 0) {
        const allowed = comparator.semver;
        if (allowed.major === version.major && allowed.minor === version.minor && allowed.patch === version.patch) {
          return true;
        }
      }
    }
    return false;
  }
  return true;
}

/** True when `version` satisfies `range`. Invalid versions or ranges return
 *  false instead of throwing. */
export function satisfies(version: string, range: string, options: { includePrerelease?: boolean } = {}): boolean {
  const parsedVersion = parseVersion(version);
  if (!parsedVersion) return false;
  const includePrerelease = options.includePrerelease === true;
  try {
    const sets = parseRange(range, includePrerelease);
    return sets.some((set) => testSet(set, parsedVersion, includePrerelease));
  } catch {
    return false;
  }
}
