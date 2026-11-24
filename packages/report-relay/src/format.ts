import { createHash } from "node:crypto";

import { isBrowserReportApp, type BugReportPayload } from "@polyth/contracts/bug-report";

/** Issue title, body, labels and fingerprint computed from an accepted report.
 *  Everything the person wrote is neutralized before it can ping a person or
 *  cross-link an issue: a zero-width joiner follows every `@` and every `#`
 *  that starts a number, both in the title and in the body. */

export const RELEASE_REPO = "Polyth/Polyth";
const ZWJ = "\u200d";
const TITLE_LINE = 80;
const TEXT_SNIPPET = 200;

export interface FormatContext {
  repo: string;
  branch: string;
  fingerprint: string;
  reportJsonPath: string;
  screenshotPath?: string;
  previousIssue?: number;
  /** The group the authenticating token belongs to. Never taken from the
   *  report body, which a client controls. */
  group: ReportGroup;
  /** Every group that already filed this fingerprint, oldest first. */
  seenInGroups?: string[];
}

/** The group a token proved: a cohort, not a person. */
export interface ReportGroup {
  id: string;
  label: string;
  keyId: string;
}

/** `<platform> <arch>` for a desktop report, `<platform> <browser>` (`ios
 *  Safari 18`) for a page opened in a browser. */
function where(report: BugReportPayload): string {
  const app = report.app;
  if (isBrowserReportApp(app)) return `${app.platform} ${app.browser || "browser"}`;
  return `${app.platform} ${app.arch}`;
}

/** `@name` and `#123` in report text can never notify or cross-link. */
export function neutralize(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9_-])/g, `@${ZWJ}`).replace(/#(?=\d)/g, `#${ZWJ}`);
}

/** Text inside a fenced block: neutralized, and no run of backticks long
 *  enough to close the fence and turn the rest into live Markdown. */
const fenced = (text: string): string => neutralize(text).replace(/`{3,}/g, (run) => run.split("").join(ZWJ));

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, TEXT_SNIPPET);

const quoted = (text: string): string => neutralize(text).split("\n").map((line) => `> ${line}`).join("\n");

/** 16 hex chars of sha256 over a stable fingerprint basis. Errors dedup on the
 *  first notice's machine-readable lines; without errors only the same install
 *  re-sending the same words dedups. */
export function fingerprintOf(report: BugReportPayload): string {
  let basis: string;
  if (report.errors.length > 0) {
    const lines = report.errors[0]!.text.split("\n");
    const picked: string[] = [];
    for (const prefix of ["Code:", "Component:", "Operation:", "HTTP status:"]) {
      const found = lines.find((line) => line.trimStart().startsWith(prefix));
      if (found) picked.push(found.trim());
    }
    let detail = picked.join("\n");
    if (picked.length === 0) {
      const index = lines.findIndex((line) => line.trimStart().startsWith("Error:"));
      if (index >= 0) {
        const next = lines[index + 1]?.trim() ?? "";
        detail = next || lines[index]!.trimStart().slice("Error:".length).trim();
      }
    }
    basis = `${detail}\n${report.app.platform}`;
  } else {
    basis = `${report.install}\n${normalize(report.text)}`;
  }
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

/** `[<version>] <first line, max 80 chars> · <platform> <arch|browser>`. */
export function issueTitle(report: BugReportPayload): string {
  const first = report.text.split("\n")[0]?.trim() ?? "";
  const description = first ? neutralize(first).slice(0, TITLE_LINE) : "No description";
  return `[${report.app.version}] ${description} · ${neutralize(where(report))}`;
}

export function issueLabels(report: BugReportPayload, group: ReportGroup): string[] {
  const labels = ["nightly-report", `v${report.app.version}`, `platform:${report.app.platform}`, `group:${group.id}`];
  if (isBrowserReportApp(report.app)) labels.push("client:browser");
  if (report.screenshot) labels.push("has-screenshot");
  if (!report.text.trim() && report.errors.length === 0) labels.push("low-signal");
  return labels;
}

const fileUrl = (context: FormatContext, path: string): string =>
  `https://github.com/${context.repo}/blob/${context.branch}/${path}?raw=true`;

/** A table cell: backslashes first, so a trailing `\` cannot eat the `|` escape. */
const cell = (value: string): string =>
  neutralize(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n|\r/g, " ");

/** `qa-eu · QA EU`, or just the id when the label adds nothing. */
export const groupName = (group: ReportGroup): string =>
  group.label && group.label !== group.id ? `${group.id} · ${group.label}` : group.id;

function details(report: BugReportPayload): string {
  const bag = JSON.stringify({ settings: report.settings, packages: report.packages, errors: report.errors }, null, 2);
  return `<details><summary>Settings and packages</summary>\n\n\`\`\`\`json\n${fenced(bag)}\n\`\`\`\`\n\n</details>`;
}

function table(report: BugReportPayload, context: FormatContext): string {
  const viewport = report.web.viewport;
  const app = report.app;
  const client: Array<[string, string]> = isBrowserReportApp(app)
    ? [
      ["Client", "browser"],
      ["Platform", app.platform],
      ["Browser", app.browser || "—"],
      ["Server", `${app.serverPlatform} ${app.serverArch}`],
    ]
    : [
      ["Platform", `${app.platform} ${app.arch}`],
      ["OS", app.osVersion],
      ["Electron", app.electron],
      ["Chromium", app.chromium],
    ];
  const rows: Array<[string, string]> = [
    ["Version", app.version],
    ["Channel", app.channel],
    ["Edition", app.edition],
    ["Group", groupName(context.group)],
    ...client,
    ["Web build", report.web.build || "—"],
    ["Server version", report.web.serverVersion || "—"],
    ["View", report.web.view || "—"],
    ["Viewport", `${viewport.width}×${viewport.height} @${viewport.scale}`],
    ["Locale", report.app.locale],
    ["Contact", report.contact ? `\`${report.contact}\`` : "—"],
  ];
  const body = rows.map(([field, value]) => `| ${field} | ${cell(value)} |`).join("\n");
  return `| Field | Value |\n| --- | --- |\n${body}`;
}

const image = (context: FormatContext): string | null =>
  context.screenshotPath ? `![screenshot](${fileUrl(context, context.screenshotPath)})` : null;

const marker = (report: BugReportPayload, context: FormatContext): string =>
  `<!-- polyth-report fp=${context.fingerprint} id=${report.reportId} group=${context.group.id} key=${context.group.keyId} -->`;

const release = (report: BugReportPayload): string => `Release: https://github.com/${RELEASE_REPO}/releases/tag/v${report.app.version}`;

export function issueBody(report: BugReportPayload, context: FormatContext): string {
  const parts: string[] = [];
  const text = report.text.trim();
  if (text) parts.push(quoted(text));
  const screenshot = image(context);
  if (screenshot) parts.push(screenshot);
  parts.push(table(report, context));
  parts.push(details(report));
  parts.push(`Report data: [report.json](${fileUrl(context, context.reportJsonPath)})`);
  if (context.previousIssue !== undefined) parts.push(`Previous report issue: ${context.previousIssue}.`);
  parts.push(release(report));
  parts.push(marker(report, context));
  return parts.join("\n\n");
}

/** The shorter comment for a repeat of an open fingerprint. */
export function commentBody(report: BugReportPayload, context: FormatContext): string {
  const parts: string[] = [];
  const text = report.text.trim();
  if (text) parts.push(quoted(text));
  const screenshot = image(context);
  if (screenshot) parts.push(screenshot);
  const os = isBrowserReportApp(report.app) ? "browser" : report.app.osVersion;
  parts.push(`**${report.app.version}** · ${cell(where(report))} · ${cell(os)} · ${cell(report.web.view || "—")}`);
  parts.push(`Group: ${cell(groupName(context.group))}`);
  const seen = context.seenInGroups ?? [];
  if (seen.length > 1) parts.push(`Seen in groups: ${cell(seen.join(", "))}`);
  parts.push(details(report));
  parts.push(`Report data: [report.json](${fileUrl(context, context.reportJsonPath)})`);
  parts.push(marker(report, context));
  return parts.join("\n\n");
}
