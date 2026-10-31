// Terminal output: colors only on a TTY (and never with NO_COLOR), tables
// that fit the terminal width, JSON for scripts.

export interface Output {
  readonly json: boolean;
  readonly color: boolean;
  readonly width: number;
  out(text?: string): void;
  err(text?: string): void;
  write(text: string): void;
  data(value: unknown): void;
}

const ESC = "\u001b[";
const paint = (code: string) => (enabled: boolean, text: string): string => enabled ? `${ESC}${code}m${text}${ESC}0m` : text;
export const style = {
  bold: paint("1"),
  dim: paint("2"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  blue: paint("34"),
  magenta: paint("35"),
  cyan: paint("36"),
  gray: paint("90"),
};

export function createOutput(opts: { json?: boolean; color?: boolean | undefined } = {}): Output {
  const tty = process.stdout.isTTY === true;
  const color = opts.color ?? (tty && !process.env.NO_COLOR && process.env.TERM !== "dumb");
  return {
    json: opts.json === true,
    color,
    width: process.stdout.columns && process.stdout.columns > 20 ? process.stdout.columns : 100,
    out(text = "") { process.stdout.write(`${text}\n`); },
    err(text = "") { process.stderr.write(`${text}\n`); },
    write(text) { process.stdout.write(text); },
    data(value) { process.stdout.write(`${JSON.stringify(value, null, process.stdout.isTTY ? 2 : 0)}\n`); },
  };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
export const visibleLength = (text: string): number => [...text.replace(ANSI, "")].length;

export function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, Math.max(0, max));
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

export const oneLine = (text: unknown): string => String(text ?? "").replace(/\s+/g, " ").trim();

/** Render rows as aligned columns. The last flexible column absorbs width. */
export function table(o: Output, headers: string[], rows: string[][], opts: { flex?: number } = {}): void {
  if (!rows.length) return;
  const flex = opts.flex ?? headers.length - 1;
  const widths = headers.map((header, i) => Math.max(visibleLength(header), ...rows.map((row) => visibleLength(row[i] ?? ""))));
  const fixed = widths.reduce((sum, width, i) => (i === flex ? sum : sum + width), 0) + (headers.length - 1) * 2;
  widths[flex] = Math.max(8, Math.min(widths[flex]!, o.width - fixed));
  const line = (cells: string[]) => cells.map((cell, i) => {
    const text = i === flex && visibleLength(cell) > widths[i]! ? truncate(cell.replace(ANSI, ""), widths[i]!) : cell;
    return i === cells.length - 1 ? text : text + " ".repeat(Math.max(0, widths[i]! - visibleLength(text)));
  }).join("  ");
  o.out(style.dim(o.color, line(headers)));
  for (const row of rows) o.out(line(row));
}

export function ago(time: number | undefined, now = Date.now()): string {
  if (!time) return "-";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function statusColor(o: Output, status: string): string {
  const s = status || "-";
  if (s === "working" || s === "reconciling") return style.cyan(o.color, s);
  if (s === "waiting" || s === "epoch-pending" || s === "unknown") return style.yellow(o.color, s);
  if (s === "failed") return style.red(o.color, s);
  if (s === "archived" || s === "finished") return style.gray(o.color, s);
  return style.green(o.color, s);
}
