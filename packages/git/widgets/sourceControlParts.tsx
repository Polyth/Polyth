// Small presentational atoms shared by every Source Control page. They carry
// no data fetching and no mutation, so lists, the log and the review panel
// can render the same grammar without importing GitView.
import type { GitFileEntry } from "@polyth/session/web-api";
import { getLocale, tr } from "../../../apps/web/src/i18n/index.ts";
import type { DiffLineStats } from "./PendingChangesBar.tsx";
import type { GitPrefs } from "./gitPrefs.ts";

type StatusKind = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange" | "untracked" | "conflicted";

const STATUS_LETTER: Record<StatusKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  untracked: "U",
  conflicted: "!",
};

export function statusLabel(status: string): string {
  switch (status) {
    case "added": return tr("gitview.added");
    case "deleted": return tr("gitview.deleted");
    case "renamed": return tr("gitview.renamed");
    case "copied": return tr("gitview.copied");
    case "typechange": return tr("gitview.typeChanged");
    case "untracked": return tr("gitview.untracked");
    case "conflicted": return tr("gitview.conflicted");
    default: return tr("gitview.modified");
  }
}

const statusKind = (status: string): StatusKind =>
  status in STATUS_LETTER ? status as StatusKind : "modified";

/** One status glyph per change kind. The letter carries the meaning; the tint
 *  only repeats it, so nothing depends on colour alone. */
export function StatusChip({ status, staged = false }: { status: string; staged?: boolean }) {
  const kind = statusKind(status);
  const label = statusLabel(kind);
  return (
    <span
      className={`git-file-letter source-status source-status--${kind}${staged && kind !== "conflicted" ? " is-staged" : ""}`}
      title={label}
      aria-label={label}
    >
      {STATUS_LETTER[kind]}
    </span>
  );
}

export function fileStatusChip(file: Pick<GitFileEntry, "status" | "staged">) {
  return <StatusChip status={file.status} staged={file.staged} />;
}

export function fileIdentity(path: string): { name: string; directory: string } {
  const separator = path.lastIndexOf("/");
  return separator < 0
    ? { name: path, directory: "" }
    : { name: path.slice(separator + 1), directory: path.slice(0, separator + 1) };
}

/** Quiet numeric pill used by tabs, group heads and section heads. A zero
 *  still renders: "Stashes 0" is information, not noise. */
export function CountBadge({ count, tone = "neutral", label }: { count: number; tone?: "neutral" | "accent" | "danger"; label?: string }) {
  return (
    <span className={`source-count source-count--${tone}`} {...(label ? { "aria-label": label } : { "aria-hidden": true })}>
      {count > 999 ? "999+" : count}
    </span>
  );
}

const BAR_CELLS = 5;

/** GitHub-style proportional bar: five cells split by the additions share. */
export function diffBarCells(stats: DiffLineStats): Array<"add" | "del" | "none"> {
  const total = stats.additions + stats.deletions;
  if (total === 0) return Array.from({ length: BAR_CELLS }, () => "none");
  const filled = Math.min(BAR_CELLS, Math.max(1, Math.ceil(Math.log2(total + 1) / 2)));
  const adds = stats.deletions === 0 ? filled : stats.additions === 0 ? 0 : Math.min(filled - 1, Math.max(1, Math.round((stats.additions / total) * filled)));
  return Array.from({ length: BAR_CELLS }, (_, index) => index < adds ? "add" : index < filled ? "del" : "none");
}

export function LineStats({ stats, mode = "numbers" }: { stats: DiffLineStats; mode?: GitPrefs["lineStats"] }) {
  if (mode === "hidden" || (stats.additions === 0 && stats.deletions === 0)) return null;
  const label = tr("pendingchangesbar.valueAdditionsValueDeletions", { additions: stats.additions, deletions: stats.deletions });
  if (mode === "bar") {
    return (
      <span className="git-file-linestat source-diffbar" role="img" aria-label={label} title={`+${stats.additions} −${stats.deletions}`}>
        {diffBarCells(stats).map((cell, index) => <i key={index} className={`source-diffbar-cell source-diffbar-cell--${cell}`} />)}
      </span>
    );
  }
  return (
    <span className="git-file-linestat" aria-label={label}>
      <span className="additions" aria-hidden="true">+{stats.additions}</span>
      <span className="deletions" aria-hidden="true">−{stats.deletions}</span>
    </span>
  );
}

const AVATAR_TONES = ["blue", "purple", "green", "amber", "red"] as const;

/** Author initials on a token wash. The tone is a stable hash of the name, so
 *  one author keeps one colour across the log without any stored palette. */
export function AuthorAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const words = name.replace(/\[bot\]$/i, "").trim().split(/[\s._-]+/).filter(Boolean);
  const initials = (words.length > 1 ? `${words[0]![0]}${words[words.length - 1]![0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return <span className={`source-avatar source-avatar--${size} source-avatar--${AVATAR_TONES[hash % AVATAR_TONES.length]}`} aria-hidden="true">{initials}</span>;
}

const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["second", 60], ["minute", 60], ["hour", 24], ["day", 7], ["week", 4.345], ["month", 12], ["year", Number.POSITIVE_INFINITY],
];

/** "3 hours ago" / locale date, with the full timestamp kept for the title. */
export function formatWhen(value: string | number | Date, style: GitPrefs["dateStyle"], now = Date.now()): { label: string; title: string } {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return { label: "", title: "" };
  const locale = getLocale();
  const title = date.toLocaleString(locale);
  if (style === "absolute") return { label: date.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }), title };
  let delta = (date.getTime() - now) / 1000;
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(delta) < size) {
      const rounded = Math.round(delta);
      if (unit === "second" && Math.abs(rounded) < 45) return { label: tr("gitview.justNow"), title };
      return { label: new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" }).format(rounded, unit), title };
    }
    delta /= size;
  }
  return { label: title, title };
}

export function When({ value, style }: { value: string | number | Date; style: GitPrefs["dateStyle"] }) {
  const { label, title } = formatWhen(value, style);
  const iso = (() => { try { return new Date(value).toISOString(); } catch { return undefined; } })();
  return <time className="source-when" dateTime={iso} title={title}>{label}</time>;
}

/** Ref badges for the log: HEAD/current, local branch, remote branch, tag. A
 *  slash alone cannot tell `origin/main` from `feature/x`, so remote-ness comes
 *  from the remote names this repository actually has. */
export function refKind(ref: string, remotes: ReadonlySet<string>): { label: string; kind: "head" | "local" | "remote" | "tag" } {
  if (ref.startsWith("tag: ")) return { label: ref.slice(5), kind: "tag" };
  if (ref.startsWith("HEAD -> ")) return { label: ref.slice(8), kind: "head" };
  if (ref === "HEAD") return { label: "HEAD", kind: "head" };
  const slash = ref.indexOf("/");
  return { label: ref, kind: slash > 0 && remotes.has(ref.slice(0, slash)) ? "remote" : "local" };
}
