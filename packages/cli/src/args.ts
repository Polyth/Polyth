// Small, dependency-free argv parser. Flags are declared per command so an
// unknown flag is a usage error instead of being silently treated as text.

export interface FlagSpec {
  /** Long name without dashes, e.g. "project". */
  name: string;
  /** Optional single-letter alias, e.g. "p". */
  short?: string;
  /** Takes a value (`--project x`, `--project=x`, `-p x`). */
  value?: boolean;
  /** May repeat; values accumulate. */
  multiple?: boolean;
  description?: string;
}

export interface Parsed {
  flags: Record<string, string | boolean | string[]>;
  positionals: string[];
  /** Everything after a bare `--`. */
  rest: string[];
}

export class UsageError extends Error {
  readonly code = "usage";
}

export function parseArgs(argv: readonly string[], specs: readonly FlagSpec[]): Parsed {
  const byLong = new Map(specs.map((spec) => [spec.name, spec]));
  const byShort = new Map(specs.filter((spec) => spec.short).map((spec) => [spec.short!, spec]));
  const flags: Parsed["flags"] = {};
  const positionals: string[] = [];
  const set = (spec: FlagSpec, value: string | boolean): void => {
    if (spec.multiple) {
      const list = (flags[spec.name] as string[] | undefined) ?? [];
      list.push(String(value));
      flags[spec.name] = list;
    } else flags[spec.name] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") return { flags, positionals, rest: argv.slice(i + 1) };
    if (arg.startsWith("--") && arg.length > 2) {
      const eq = arg.indexOf("=");
      const name = arg.slice(2, eq === -1 ? undefined : eq);
      const negated = name.startsWith("no-") && byLong.has(name.slice(3)) && !byLong.get(name.slice(3))!.value;
      const spec = byLong.get(negated ? name.slice(3) : name);
      if (!spec) throw new UsageError(`unknown option --${name}`);
      if (negated) { flags[spec.name] = false; continue; }
      if (spec.value) {
        const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
        set(spec, value);
      } else {
        if (eq !== -1) throw new UsageError(`--${name} does not take a value`);
        set(spec, true);
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1 && arg !== "-") {
      // Clustered short booleans (-fy) or one short with a value (-p x, -px).
      for (let j = 1; j < arg.length; j++) {
        const spec = byShort.get(arg[j]!);
        if (!spec) throw new UsageError(`unknown option -${arg[j]}`);
        if (spec.value) {
          const inline = arg.slice(j + 1);
          const value = inline || argv[++i];
          if (value === undefined) throw new UsageError(`-${arg[j]} needs a value`);
          set(spec, value);
          break;
        }
        set(spec, true);
      }
      continue;
    }
    positionals.push(arg);
  }
  return { flags, positionals, rest: [] };
}

export const str = (parsed: Parsed, name: string): string | undefined => {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
};
export const bool = (parsed: Parsed, name: string): boolean => parsed.flags[name] === true;
export const list = (parsed: Parsed, name: string): string[] => {
  const value = parsed.flags[name];
  if (Array.isArray(value)) return value.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
  return typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
};
export function int(parsed: Parsed, name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = str(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new UsageError(`--${name} must be an integer from ${min} to ${max}`);
  return value;
}
/** Seconds as a duration flag ("30", "30s", "5m", "2h"). */
export function seconds(parsed: Parsed, name: string, fallback: number): number {
  const raw = str(parsed, name);
  if (raw === undefined) return fallback;
  const match = /^(\d+)(s|m|h)?$/.exec(raw.trim());
  if (!match) throw new UsageError(`--${name} must look like 30, 30s, 5m or 2h`);
  const value = Number(match[1]);
  return value * (match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1);
}
