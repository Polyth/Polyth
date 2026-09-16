from __future__ import annotations

from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)


def replace(path: str, old: str, new: str, *, count: int = 1) -> None:
    text = read(path)
    found = text.count(old)
    if found < count:
        raise RuntimeError(f"{path}: expected at least {count} occurrences, found {found}: {old[:100]!r}")
    write(path, text.replace(old, new, count))


def sub(path: str, pattern: str, replacement: str, *, flags: int = re.S, count: int = 1) -> None:
    text = read(path)
    next_text, changed = re.subn(pattern, lambda _m: replacement, text, count=count, flags=flags)
    if changed != count:
        raise RuntimeError(f"{path}: expected {count} regex replacements, got {changed}: {pattern[:100]!r}")
    write(path, next_text)


# ---------------------------------------------------------------------------
# Generic, content-addressed trust receipt. Authorization stays in permissions;
# feature packages retain their own canonical state and merely embed receipts.
# ---------------------------------------------------------------------------
permissions = "packages/permissions/src/index.ts"
trust_block = r'''

// ---- content-bound trust -----------------------------------------------------

/** Approval for one exact version of repository-controlled executable content.
 * The receipt is deliberately generic: consumers keep their own canonical
 * state and embed this immutable authorization evidence rather than creating a
 * parallel permission store. */
export type ContentTrustApprovalScope = "current-version" | "once";

export interface ContentTrustSubject {
  spaceId: string;
  projectId: string;
  sourceKind: string;
  sourceIdentity: string;
  contentDigest: string;
  semanticDigest?: string;
}

export interface ContentTrustReceipt extends ContentTrustSubject {
  version: 1;
  approvalScope: ContentTrustApprovalScope;
  approvedAt: number;
}

export function issueContentTrustReceipt(
  subject: ContentTrustSubject,
  approvalScope: ContentTrustApprovalScope,
  approvedAt = Date.now(),
): ContentTrustReceipt {
  if (!subject.spaceId || !subject.projectId || !subject.sourceKind || !subject.sourceIdentity || !subject.contentDigest) {
    throw new Error("content trust subject is incomplete");
  }
  return { version: 1, ...subject, approvalScope, approvedAt };
}

/** Trust is content- and identity-bound. Any mismatch fails closed; callers
 * may additionally require a particular approval scope. */
export function contentTrustMatches(
  receipt: ContentTrustReceipt | undefined,
  subject: ContentTrustSubject,
  approvalScope?: ContentTrustApprovalScope,
): boolean {
  if (!receipt || receipt.version !== 1) return false;
  return receipt.spaceId === subject.spaceId
    && receipt.projectId === subject.projectId
    && receipt.sourceKind === subject.sourceKind
    && receipt.sourceIdentity === subject.sourceIdentity
    && receipt.contentDigest === subject.contentDigest
    && (receipt.semanticDigest ?? "") === (subject.semanticDigest ?? "")
    && (approvalScope === undefined || receipt.approvalScope === approvalScope);
}
'''
text = read(permissions)
if "export interface ContentTrustReceipt" not in text:
    write(permissions, text.rstrip() + trust_block + "\n")

# Schedule owns loop state but uses the generic receipt contract.
pkg_path = ROOT / "packages/schedule/package.json"
pkg = json.loads(pkg_path.read_text())
pkg["dependencies"]["@polyth/permissions"] = "0.1.0"
pkg_path.write_text(json.dumps(pkg, indent=2) + "\n")

# Canonical content identity is a full SHA-256, not a shortened display hash.
replace(
    "packages/schedule/src/loops.ts",
    'const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);',
    'const digest = createHash("sha256").update(text).digest("hex");',
)

schedule = "packages/schedule/src/index.ts"
replace(schedule, 'import { randomUUID } from "node:crypto";', 'import { createHash, randomUUID } from "node:crypto";')
replace(
    schedule,
    'import { atomicWriteSync } from "@polyth/plugins";\n',
    'import { atomicWriteSync } from "@polyth/plugins";\nimport { contentTrustMatches, issueContentTrustReceipt, type ContentTrustReceipt, type ContentTrustSubject } from "@polyth/permissions";\n',
)

# Trust/pending contracts live next to schedule contracts, not in a new service.
replace(
    schedule,
    'export type OverlapPolicy = "skip" | "queue" | "parallel";\n',
    '''export type OverlapPolicy = "skip" | "queue" | "parallel";\n\nexport type LoopTrustState = "untrusted" | "trusted-current-version" | "changed-since-trust";\n\n/** Metadata for a repository version that is visible but not executable yet.\n * The unapproved prompt is intentionally not copied into schedule.json; trust\n * and run-once re-read the repository and validate this digest first. */\nexport interface PendingLoopVersion {\n  sourceDigest: string;\n  semanticDigest: string;\n  changedFields: string[];\n  observedAt: number;\n}\n''',
)
replace(
    schedule,
    '  agentProfile?: string;\n}',
    '''  agentProfile?: string;\n  /** Content-bound authorization for the executable snapshot currently stored\n   * in prompt/cadence/title/agentProfile. */\n  trustReceipt?: ContentTrustReceipt;\n  trustState?: LoopTrustState;\n  /** New repository version awaiting a user decision. No executable content. */\n  pendingVersion?: PendingLoopVersion;\n  rejectedSourceDigest?: string;\n}''',
)
replace(
    schedule,
    '  /** Hide one diagnostic until its error text changes on a later scan. */\n  dismissLoopError(projectId: string, path: string): boolean;\n',
    '''  /** Hide one diagnostic until its error text changes on a later scan. */\n  dismissLoopError(projectId: string, path: string): boolean;\n  /** Promote exactly the currently observed repository version to executable. */\n  trustLoopVersion(id: string, spaceId: string, file: LoopFileResult): ScheduleTask;\n  /** Execute exactly the currently observed repository version once without\n   * granting persistent trust. The managed task remains blocked afterwards. */\n  runLoopVersionOnce(id: string, spaceId: string, file: LoopFileResult): Promise<ScheduleTask>;\n  /** Keep the current repository version blocked. */\n  rejectLoopVersion(id: string): ScheduleTask;\n''',
)

# Pure trust helpers: stable semantic digest, compact field-level change list,
# and a reusable execution-time assertion for the server runner.
anchor = '/** Next fire time. One-shots aim at their `at`; intervals run from the last\n'
helpers = r'''const loopExecutableShape = (loop: NonNullable<LoopFileResult["loop"]>) => ({
  title: loop.title,
  cadence: { kind: "cron" as const, expression: loop.cron, timeZone: loop.timeZone },
  enabled: loop.enabled,
  agentProfile: loop.agentProfile ?? null,
  prompt: loop.prompt,
});

export function loopSemanticDigest(loop: NonNullable<LoopFileResult["loop"]>): string {
  return createHash("sha256").update(JSON.stringify(loopExecutableShape(loop))).digest("hex");
}

function applyLoopExecutable(task: ScheduleTask, loop: NonNullable<LoopFileResult["loop"]>): void {
  task.prompt = loop.prompt;
  task.cadence = { kind: "cron", expression: loop.cron, timeZone: loop.timeZone };
  task.title = loop.title;
  if (loop.agentProfile) task.agentProfile = loop.agentProfile;
  else delete task.agentProfile;
  mirrorCadence(task);
}

function changedLoopFields(
  task: ScheduleTask,
  loop: NonNullable<LoopFileResult["loop"]>,
  sourcePath: string,
): string[] {
  const fields: string[] = [];
  if (task.sourcePath && task.sourcePath !== sourcePath) fields.push("sourcePath");
  if (task.prompt !== loop.prompt) fields.push("prompt");
  if (task.title !== loop.title) fields.push("title");
  if (task.cadence.kind !== "cron"
    || task.cadence.expression !== loop.cron
    || task.cadence.timeZone !== loop.timeZone) fields.push("schedule");
  if ((task.agentProfile ?? "") !== (loop.agentProfile ?? "")) fields.push("agentProfile");
  const approvedEnabled = task.enabledOverride ?? task.enabled;
  if (approvedEnabled !== loop.enabled) fields.push("enabled");
  return fields;
}

const trustSubject = (
  task: Pick<ScheduleTask, "projectId" | "sourcePath">,
  file: LoopFileResult,
  spaceId: string,
): ContentTrustSubject => {
  if (!file.loop || !file.digest || !task.sourcePath) throw err("loop version is not executable", "content-trust-changed");
  return {
    spaceId,
    projectId: task.projectId,
    sourceKind: "agents-loop",
    sourceIdentity: file.path,
    contentDigest: file.digest,
    semanticDigest: loopSemanticDigest(file.loop),
  };
};

/** Final execution gate. The server calls this immediately before dispatch so
 * an external edit, checkout, pull, merge, or rebase cannot exploit the scan
 * interval. Content identity, not Git metadata, is authoritative. */
export function assertLoopExecutionTrusted(
  task: ScheduleTask,
  file: LoopFileResult | undefined,
  spaceId: string,
): void {
  if (task.source !== "loop-file") return;
  if (!file?.loop || !task.sourcePath || file.path !== task.sourcePath || file.digest !== task.sourceDigest) {
    throw err("Loop content changed since approval. Review and trust the current version before it can run.", "content-trust-changed");
  }
  if (!contentTrustMatches(task.trustReceipt, trustSubject(task, file, spaceId))) {
    throw err("Loop content is not trusted for this exact version.", "content-trust-required");
  }
}

function observedPending(
  task: ScheduleTask,
  file: LoopFileResult,
  now: number,
  changedFields: string[],
): PendingLoopVersion {
  return {
    sourceDigest: file.digest,
    semanticDigest: file.loop ? loopSemanticDigest(file.loop) : "",
    changedFields: changedFields.length ? changedFields : ["content"],
    observedAt: now,
  };
}

'''
text = read(schedule)
if "export function loopSemanticDigest" not in text:
    if anchor not in text:
        raise RuntimeError("schedule helper anchor missing")
    write(schedule, text.replace(anchor, helpers + anchor, 1))

# Fail-close migration for pre-receipt managed loops. A later scan populates
# pending metadata, but no legacy task can fire in the meantime.
replace(
    schedule,
    '''  for (const t of tasks) {\n    if (!t.cadence) {\n      t.cadence = t.kind === "at"\n        ? { kind: "at", at: t.at ?? 0 }\n        : { kind: "every", everyMinutes: t.everyMinutes ?? 1 };\n      migrated = true;\n    }\n  }\n''',
    '''  for (const t of tasks) {\n    if (!t.cadence) {\n      t.cadence = t.kind === "at"\n        ? { kind: "at", at: t.at ?? 0 }\n        : { kind: "every", everyMinutes: t.everyMinutes ?? 1 };\n      migrated = true;\n    }\n    if (t.source === "loop-file" && !t.trustReceipt) {\n      t.trustState = "untrusted";\n      t.enabled = false;\n      t.nextRunAt = null;\n      migrated = true;\n    }\n  }\n''',
)
replace(schedule, 'atomicWriteSync(opts.file, JSON.stringify({ v: 2, tasks, loopErrors: loopErrorsByProject }, null, 2));', 'atomicWriteSync(opts.file, JSON.stringify({ v: 3, tasks, loopErrors: loopErrorsByProject }, null, 2));')

# Separate canonical run accounting from the exact executable snapshot so
# trust-once can execute B while the stored last-approved snapshot remains A.
replace(
    schedule,
    '  const execute = async (task: ScheduleTask): Promise<void> => {',
    '  const execute = async (task: ScheduleTask, executableTask: ScheduleTask = task): Promise<void> => {',
)
replace(schedule, '      const outcome = await opts.runner.run(task, runId);', '      const outcome = await opts.runner.run(executableTask, runId);')
replace(
    schedule,
    '  const fire = async (task: ScheduleTask): Promise<void> => {',
    '  const fire = async (task: ScheduleTask, executableTask: ScheduleTask = task): Promise<void> => {',
)
replace(schedule, '    const p = start.then(() => execute(task)).finally(() => {', '    const p = start.then(() => execute(task, executableTask)).finally(() => {')

# setEnabled cannot become a trust bypass; runNow/tick are also gated.
replace(
    schedule,
    '''    setEnabled(id, enabled) {\n      const t = mustGet(id);\n      if (t.source === "loop-file") {\n        // Local override; the file's enabled flag stays authoritative on disk.\n        t.enabledOverride = enabled;\n      }\n      t.enabled = enabled;''',
    '''    setEnabled(id, enabled) {\n      const t = mustGet(id);\n      if (t.source === "loop-file") {\n        if (enabled && t.trustState !== "trusted-current-version") {\n          throw err("trust the current loop version before activating it", "content-trust-required");\n        }\n        // Local override; the file's enabled flag stays authoritative on disk.\n        t.enabledOverride = enabled;\n      }\n      t.enabled = enabled;''',
)
replace(
    schedule,
    '''    async runNow(id) {\n      const t = mustGet(id);\n      await fire(t);\n      return t;\n    },\n    async tick() {\n      const t0 = now();\n      const due = tasks.filter((t) => t.enabled && !t.parseError && t.nextRunAt !== null && t.nextRunAt <= t0);''',
    '''    async runNow(id) {\n      const t = mustGet(id);\n      if (t.source === "loop-file" && t.trustState !== "trusted-current-version") {\n        throw err("this repository-managed loop version is blocked pending trust", "content-trust-required");\n      }\n      await fire(t);\n      return t;\n    },\n    async tick() {\n      const t0 = now();\n      const due = tasks.filter((t) => t.enabled && !t.parseError\n        && (t.source !== "loop-file" || t.trustState === "trusted-current-version")\n        && t.nextRunAt !== null && t.nextRunAt <= t0);''',
)

# Replace loop reconciliation as one unit. Existing task/history stays canonical;
# changed repository content only updates observation metadata until approved.
sync_replacement = r'''    syncLoops(projectId, scan, syncOpts) {
      const errors: Array<{ path: string; error: string }> = [];
      const seenIds = new Set<string>();
      for (const file of scan) {
        if (!file.loop) {
          if (file.parseError) {
            errors.push({ path: file.path, error: file.parseError });
            const existing = tasks.find((t) => t.projectId === projectId && t.source === "loop-file" && t.sourcePath === file.path);
            if (existing) {
              existing.parseError = file.parseError;
              if (existing.loopId) seenIds.add(existing.loopId);
              if (file.digest && file.digest !== existing.sourceDigest) {
                existing.sourceDigest = file.digest;
                existing.trustState = existing.trustReceipt ? "changed-since-trust" : "untrusted";
                existing.pendingVersion = {
                  sourceDigest: file.digest,
                  semanticDigest: "",
                  changedFields: ["content"],
                  observedAt: now(),
                };
                existing.enabled = false;
                existing.nextRunAt = null;
                existing.updatedAt = now();
              }
            }
          }
          continue;
        }
        const loop = file.loop;
        seenIds.add(loop.id);
        let t = tasks.find((x) => x.projectId === projectId && x.source === "loop-file" && x.loopId === loop.id);
        if (!t) {
          t = {
            id: randomUUID(),
            projectId,
            prompt: loop.prompt,
            kind: "cron",
            cadence: { kind: "cron", expression: loop.cron, timeZone: loop.timeZone },
            enabled: false,
            createdAt: now(),
            updatedAt: now(),
            nextRunAt: null,
            runs: 0,
            source: "loop-file",
            sourcePath: file.path,
            sourceDigest: file.digest,
            loopId: loop.id,
            trustState: "untrusted",
            pendingVersion: {
              sourceDigest: file.digest,
              semanticDigest: loopSemanticDigest(loop),
              changedFields: ["initialVersion"],
              observedAt: now(),
            },
            ...(loop.agentProfile ? { agentProfile: loop.agentProfile } : {}),
            ...(loop.title ? { title: loop.title } : {}),
          };
          mirrorCadence(t);
          tasks.push(t);
          continue;
        }

        const priorPath = t.sourcePath;
        const fields = changedLoopFields(t, loop, file.path);
        const subject: ContentTrustSubject = {
          spaceId: t.trustReceipt?.spaceId ?? "__untrusted__",
          projectId,
          sourceKind: "agents-loop",
          sourceIdentity: file.path,
          contentDigest: file.digest,
          semanticDigest: loopSemanticDigest(loop),
        };
        const trustedCurrent = !!t.trustReceipt
          && contentTrustMatches(t.trustReceipt, subject, "current-version");

        t.sourcePath = file.path;
        t.sourceDigest = file.digest;
        delete t.parseError;

        if (trustedCurrent) {
          // Rehydrating from the exact approved bytes is safe and repairs any
          // stale in-memory projection without broadening trust.
          applyLoopExecutable(t, loop);
          t.trustState = "trusted-current-version";
          delete t.pendingVersion;
          delete t.rejectedSourceDigest;
          t.enabled = t.enabledOverride ?? loop.enabled;
          t.nextRunAt = computeNextRun(t, now());
        } else {
          // With no approved snapshot yet, keep the latest parsed content for
          // display. Once any receipt exists, NEVER overwrite its executable
          // snapshot with repository bytes before reapproval.
          if (!t.trustReceipt) applyLoopExecutable(t, loop);
          t.trustState = t.trustReceipt ? "changed-since-trust" : "untrusted";
          t.pendingVersion = observedPending(t, file, now(),
            fields.length ? fields : (priorPath !== file.path ? ["sourcePath"] : ["content"]));
          if (t.rejectedSourceDigest !== file.digest) delete t.rejectedSourceDigest;
          t.enabled = false;
          t.nextRunAt = null;
        }
        t.updatedAt = now();
      }
      // Managed tasks whose file/id vanished: preserve the existing explicit
      // remove policy. A changed file, unlike a removed file, always retains
      // the last approved task/history above.
      tasks = tasks.filter((t) =>
        !(t.projectId === projectId && t.source === "loop-file" && t.loopId && !seenIds.has(t.loopId)));
      const prevErrors = loopErrorsByProject[projectId] ?? [];
      loopErrorsByProject[projectId] = errors.map((e) => {
        const old = prevErrors.find((p) => p.path === e.path && p.error === e.error);
        return {
          path: e.path,
          error: e.error,
          firstSeenAt: old?.firstSeenAt ?? now(),
          lastSeenAt: now(),
          ...(old?.dismissed && !syncOpts?.explicit ? { dismissed: true } : {}),
        };
      });
      save();
      return {
        tasks: tasks.filter((t) => t.projectId === projectId && t.source === "loop-file"),
        errors,
      };
    },
    trustLoopVersion(id, spaceId, file) {
      const t = mustGet(id);
      if (t.source !== "loop-file" || !t.loopId || !t.sourcePath || !file.loop) {
        throw err("task is not a valid repository-managed loop", "invalid-input");
      }
      if (file.path !== t.sourcePath || file.loop.id !== t.loopId
        || !file.digest || file.digest !== t.sourceDigest) {
        throw err("loop changed again; rescan and review the current version", "content-trust-changed");
      }
      const subject = trustSubject(t, file, spaceId);
      t.trustReceipt = issueContentTrustReceipt(subject, "current-version", now());
      applyLoopExecutable(t, file.loop);
      t.trustState = "trusted-current-version";
      delete t.pendingVersion;
      delete t.rejectedSourceDigest;
      delete t.parseError;
      t.enabled = t.enabledOverride ?? file.loop.enabled;
      t.updatedAt = now();
      t.nextRunAt = computeNextRun(t, now());
      save();
      return t;
    },
    async runLoopVersionOnce(id, spaceId, file) {
      const t = mustGet(id);
      if (t.source !== "loop-file" || !t.loopId || !t.sourcePath || !file.loop) {
        throw err("task is not a valid repository-managed loop", "invalid-input");
      }
      if (file.path !== t.sourcePath || file.loop.id !== t.loopId
        || !file.digest || file.digest !== t.sourceDigest) {
        throw err("loop changed again; rescan and review the current version", "content-trust-changed");
      }
      const executable: ScheduleTask = {
        ...t,
        prompt: file.loop.prompt,
        title: file.loop.title,
        cadence: { kind: "cron", expression: file.loop.cron, timeZone: file.loop.timeZone },
        kind: "cron",
        enabled: true,
        sourceDigest: file.digest,
        trustReceipt: issueContentTrustReceipt(trustSubject(t, file, spaceId), "once", now()),
        trustState: "trusted-current-version",
        ...(file.loop.agentProfile ? { agentProfile: file.loop.agentProfile } : {}),
      };
      if (!file.loop.agentProfile) delete executable.agentProfile;
      await fire(t, executable);
      // fire mutates only canonical run bookkeeping. The repository version is
      // still pending and persistent trust remains bound to the old receipt.
      t.enabled = false;
      t.nextRunAt = null;
      save();
      return t;
    },
    rejectLoopVersion(id) {
      const t = mustGet(id);
      if (t.source !== "loop-file" || !t.sourceDigest) {
        throw err("task is not a repository-managed loop", "invalid-input");
      }
      t.rejectedSourceDigest = t.sourceDigest;
      t.enabled = false;
      t.nextRunAt = null;
      t.updatedAt = now();
      save();
      return t;
    },
    loopErrors(projectId) {'''
sub(
    schedule,
    r'    syncLoops\(projectId, scan, syncOpts\) \{.*?\n    \},\n    loopErrors\(projectId\) \{',
    sync_replacement,
)

# ---------------------------------------------------------------------------
# Server: approval routes re-read the repository, and the runner re-reads it
# immediately before dispatch. This closes the 60s scanner TOCTOU window.
# ---------------------------------------------------------------------------
server = "packages/schedule/src/serverEntry.ts"
replace(
    server,
    '  createScheduleService,\n  scanLoopsDir,\n',
    '  assertLoopExecutionTrusted,\n  createScheduleService,\n  scanLoopsDir,\n',
)
replace(
    server,
    '  return async ({ path, method, url, body, json }) => {\n',
    '  return async (rc) => {\n    const { path, method, url, body, json } = rc;\n',
)
trust_route = r'''    const trustMatch = path.match(/^\/api\/schedule\/([^/]+)\/trust$/);
    if (trustMatch && method === "POST") {
      const id = trustMatch[1]!;
      const task = deps.schedule.get(id);
      if (!task || task.source !== "loop-file" || !task.sourcePath || !task.loopId) {
        json(404, { error: "not-found", message: "managed loop task not found" });
        return true;
      }
      const project = await deps.projects.get(task.projectId);
      if (!project) {
        json(404, { error: "not-found", message: "project not found" });
        return true;
      }
      // Re-read at the decision boundary. A stale UI cannot approve bytes it
      // reviewed earlier if the repository changed again in the meantime.
      const current = scanLoopsDir(project.path)
        .find((file) => file.path === task.sourcePath && file.loop?.id === task.loopId);
      if (!current?.loop || current.digest !== task.sourceDigest) {
        deps.schedule.syncLoops(task.projectId, scanLoopsDir(project.path), { explicit: true });
        json(409, { error: "content-trust-changed", message: "Loop changed again. Refresh and review the current version." });
        return true;
      }
      const input = await body();
      const action = String(input.action ?? "");
      if (action === "trust-current") {
        json(200, deps.schedule.trustLoopVersion(id, rc.space.spaceId, current));
        return true;
      }
      if (action === "run-once") {
        json(200, await deps.schedule.runLoopVersionOnce(id, rc.space.spaceId, current));
        return true;
      }
      if (action === "reject") {
        json(200, deps.schedule.rejectLoopVersion(id));
        return true;
      }
      json(400, { error: "invalid-input", message: "action must be trust-current, run-once, or reject" });
      return true;
    }

'''
text = read(server)
needle = '    const match = path.match(\n      /^\\/api\\/schedule\\/([^/]+)(?:\\/(pause|resume|run|runs))?$/,\n    );\n'
if trust_route.strip() not in text:
    if needle not in text:
        raise RuntimeError("schedule route insertion anchor missing")
    write(server, text.replace(needle, trust_route + needle, 1))

# Runner validation before any session creation/message makes every execution
# authoritative against filesystem content, not just the background scanner.
replace(
    server,
    '''      run: async (task, runId) => {\n        const mode = task.target?.mode ?? (task.sessionId ? "existing-session" : "new-session-per-run");''',
    '''      run: async (task, runId) => {\n        if (task.source === "loop-file") {\n          const project = await host.projects.get(task.projectId);\n          if (!project || !task.sourcePath || !task.loopId) {\n            throw Object.assign(new Error("managed loop project/source is unavailable"), { code: "content-trust-changed" });\n          }\n          const current = scanLoopsDir(project.path)\n            .find((file) => file.path === task.sourcePath && file.loop?.id === task.loopId);\n          assertLoopExecutionTrusted(task, current, project.spaceId);\n        }\n        const mode = task.target?.mode ?? (task.sessionId ? "existing-session" : "new-session-per-run");''',
)

# ---------------------------------------------------------------------------
# Web/API contract + compact existing-row UX. No separate trust screen/state.
# ---------------------------------------------------------------------------
webapi = "packages/session/src/webApi.ts"
replace(
    webapi,
    '  source?: "ui" | "loop-file";\n  sourcePath?: string;\n  parseError?: string;\n  loopId?: string;\n}',
    '''  source?: "ui" | "loop-file";\n  sourcePath?: string;\n  sourceDigest?: string;\n  parseError?: string;\n  loopId?: string;\n  trustState?: "untrusted" | "trusted-current-version" | "changed-since-trust";\n  trustReceipt?: {\n    version: 1;\n    spaceId: string;\n    projectId: string;\n    sourceKind: string;\n    sourceIdentity: string;\n    contentDigest: string;\n    semanticDigest?: string;\n    approvalScope: "current-version" | "once";\n    approvedAt: number;\n  };\n  pendingVersion?: {\n    sourceDigest: string;\n    semanticDigest: string;\n    changedFields: string[];\n    observedAt: number;\n  };\n  rejectedSourceDigest?: string;\n}''',
)
replace(
    webapi,
    '''  scheduleRun: (id: string) =>\n    jfetch<ScheduleTaskDto>(`/api/schedule/${encodeURIComponent(id)}/run`, { method: "POST" }),\n''',
    '''  scheduleRun: (id: string) =>\n    jfetch<ScheduleTaskDto>(`/api/schedule/${encodeURIComponent(id)}/run`, { method: "POST" }),\n  scheduleLoopTrust: (id: string, action: "trust-current" | "run-once" | "reject") =>\n    jfetch<ScheduleTaskDto>(`/api/schedule/${encodeURIComponent(id)}/trust`, json("POST", { action })),\n''',
)

actions = "packages/schedule/widgets/plannerTaskActions.ts"
text = read(actions)
if "reviewLoopVersion" not in text:
    text = text.rstrip() + r'''

export async function reviewLoopVersion(
  taskId: string,
  action: "trust-current" | "run-once" | "reject",
): Promise<boolean> {
  try {
    await api.scheduleLoopTrust(taskId, action);
    return true;
  } catch (cause) {
    return fail(cause);
  }
}
''' + "\n"
    write(actions, text)

row = "packages/schedule/widgets/PlannerTaskRow.tsx"
replace(
    row,
    '  runPlannerTask,\n} from "./plannerTaskActions.ts";',
    '  runPlannerTask,\n  reviewLoopVersion,\n} from "./plannerTaskActions.ts";',
)
replace(
    row,
    '  const loopFile = isLoopFile(task);\n',
    '  const loopFile = isLoopFile(task);\n  const trustPending = loopFile && task.trustState !== "trusted-current-version";\n',
)
# Replace the menu definition wholesale so normal Run now cannot misleadingly
# appear for blocked repository content.
sub(
    row,
    r'  const entries: MenuEntry\[\] = \[.*?\n  \];\n\n  return \(',
    r'''  const entries: MenuEntry[] = [
    ...(trustPending
      ? [
          { id: "trust-current", label: "Trust this version", icon: PlayIcon, onSelect: () => void reviewLoopVersion(task.id, "trust-current").then((ok) => { if (ok) onChanged(); }) } satisfies MenuEntry,
          { id: "run-once", label: "Run this version once", icon: PlayIcon, onSelect: () => void reviewLoopVersion(task.id, "run-once").then((ok) => { if (ok) onChanged(); }) } satisfies MenuEntry,
          { id: "reject-version", label: "Keep blocked", icon: PauseIcon, onSelect: () => void reviewLoopVersion(task.id, "reject").then((ok) => { if (ok) onChanged(); }) } satisfies MenuEntry,
          "separator" as const,
        ]
      : [{ id: "run", label: tr("scheduleview.runNow"), icon: PlayIcon, onSelect: () => void runPlannerTask(task.id).then((ok) => { if (ok) onChanged(); }) } satisfies MenuEntry]),
    { id: "edit", label: tr("common.edit"), icon: EditIcon, onSelect: onEdit },
    { id: "runs", label: tr("scheduleview.viewRuns"), onSelect: onViewRuns },
    ...(!loopFile
      ? [{ id: "duplicate", label: tr("scheduleview.duplicate"), icon: CopyIcon, onSelect: () => void duplicatePlannerTask(task).then((ok) => { if (ok) onChanged(); }) } satisfies MenuEntry]
      : []),
    ...(!completed && !trustPending
      ? [{
          id: "toggle",
          label: enabled ? tr("common.pause") : tr("scheduleview.activate"),
          icon: enabled ? PauseIcon : PlayIcon,
          onSelect: () => void toggle(!enabled),
        } satisfies MenuEntry]
      : []),
    ...(!loopFile
      ? [
          "separator" as const,
          { id: "delete", label: tr("common.delete"), icon: DeleteIcon, danger: true, onSelect: () => void deletePlannerTask(task).then((ok) => { if (ok) onChanged(); }) } satisfies MenuEntry,
        ]
      : []),
  ];

  return (''',
)
replace(
    row,
    '          {title}\n        </span>\n',
    '''          {title}\n          {trustPending && (\n            <Badge tone="accent">Review required</Badge>\n          )}\n        </span>\n''',
)
replace(
    row,
    '        {task.parseError && <span className="planner-task-error">{task.parseError}</span>}\n',
    '''        {trustPending && (\n          <span className="planner-task-error">\n            {task.sourcePath ? `${task.sourcePath} · ` : ""}\n            {task.trustReceipt?.contentDigest ? `trusted ${task.trustReceipt.contentDigest.slice(0, 8)} → ` : ""}\n            {task.sourceDigest?.slice(0, 8) ?? "new"}\n            {task.pendingVersion?.changedFields?.length ? ` · ${task.pendingVersion.changedFields.join(", ")}` : ""}\n          </span>\n        )}\n        {task.parseError && <span className="planner-task-error">{task.parseError}</span>}\n''',
)
replace(
    row,
    '        {showActiveSwitch && (\n',
    '        {showActiveSwitch && !trustPending && (\n',
)

# ---------------------------------------------------------------------------
# Tests: content A approval, content B invalidation, trust-once, persistence,
# and the immediate execution gate against an external edit.
# ---------------------------------------------------------------------------
test_path = ROOT / "packages/schedule/test/contentTrust.test.ts"
test_path.write_text(r'''import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertLoopExecutionTrusted,
  createScheduleService,
  loopSemanticDigest,
  type ScheduleTask,
} from "../src/index.ts";
import type { LoopFileResult, LoopSpec } from "../src/loops.ts";

const loop = (prompt: string, overrides: Partial<LoopSpec> = {}): LoopSpec => ({
  id: "nightly",
  title: "Nightly review",
  cron: "0 2 * * *",
  timeZone: "UTC",
  enabled: true,
  prompt,
  ...overrides,
});

const file = (digest: string, spec: LoopSpec): LoopFileResult => ({
  path: "/repo/.agents/loops/nightly.md",
  digest,
  loop: spec,
});

test("repository loop trust is bound to exact content and preserves last approved executable snapshot", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-loop-trust-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 1_700_000_000_000;
  const runs: Array<{ prompt: string; scope?: string; digest?: string }> = [];
  const schedule = createScheduleService({
    file: join(dir, "schedule.json"),
    now: () => now,
    runner: {
      async run(task) {
        runs.push({
          prompt: task.prompt,
          scope: task.trustReceipt?.approvalScope,
          digest: task.trustReceipt?.contentDigest,
        });
      },
    },
  });

  const a = file("a".repeat(64), loop("approved A"));
  const first = schedule.syncLoops("project-1", [a]).tasks[0]!;
  assert.equal(first.trustState, "untrusted");
  assert.equal(first.enabled, false);
  assert.equal(first.nextRunAt, null);
  await assert.rejects(() => schedule.runNow(first.id), (error: unknown) =>
    (error as { code?: string }).code === "content-trust-required");

  const trustedA = schedule.trustLoopVersion(first.id, "space-1", a);
  assert.equal(trustedA.trustState, "trusted-current-version");
  assert.equal(trustedA.trustReceipt?.contentDigest, a.digest);
  assert.equal(trustedA.enabled, true);
  await schedule.runNow(first.id);
  assert.deepEqual(runs.at(-1), { prompt: "approved A", scope: "current-version", digest: a.digest });

  now += 1_000;
  const b = file("b".repeat(64), loop("pending B", { title: "Changed title", agentProfile: "reviewer" }));
  const changed = schedule.syncLoops("project-1", [b]).tasks[0]!;
  assert.equal(changed.trustState, "changed-since-trust");
  assert.equal(changed.enabled, false);
  assert.equal(changed.prompt, "approved A", "unapproved repository prompt must never replace executable snapshot A");
  assert.equal(changed.trustReceipt?.contentDigest, a.digest, "old approval remains history/evidence only");
  assert.equal(changed.sourceDigest, b.digest);
  assert.ok(changed.pendingVersion?.changedFields.includes("prompt"));
  assert.ok(changed.pendingVersion?.changedFields.includes("title"));
  assert.ok(changed.pendingVersion?.changedFields.includes("agentProfile"));

  const beforeTick = runs.length;
  await schedule.tick();
  assert.equal(runs.length, beforeTick, "blocked content must not fire from the clock");

  await schedule.runLoopVersionOnce(first.id, "space-1", b);
  assert.deepEqual(runs.at(-1), { prompt: "pending B", scope: "once", digest: b.digest });
  const afterOnce = schedule.get(first.id)!;
  assert.equal(afterOnce.prompt, "approved A");
  assert.equal(afterOnce.trustState, "changed-since-trust");
  assert.equal(afterOnce.enabled, false);
  assert.equal(afterOnce.trustReceipt?.contentDigest, a.digest);

  const trustedB = schedule.trustLoopVersion(first.id, "space-1", b);
  assert.equal(trustedB.prompt, "pending B");
  assert.equal(trustedB.title, "Changed title");
  assert.equal(trustedB.agentProfile, "reviewer");
  assert.equal(trustedB.trustReceipt?.contentDigest, b.digest);
  assert.equal(trustedB.pendingVersion, undefined);
  await schedule.runNow(first.id);
  assert.deepEqual(runs.at(-1), { prompt: "pending B", scope: "current-version", digest: b.digest });
});

test("execution-time gate rejects filesystem content that changed after scan", () => {
  const approved = file("a".repeat(64), loop("A"));
  const changed = file("b".repeat(64), loop("B"));
  const task: ScheduleTask = {
    id: "t",
    projectId: "project-1",
    prompt: approved.loop!.prompt,
    title: approved.loop!.title,
    kind: "cron",
    cadence: { kind: "cron", expression: approved.loop!.cron, timeZone: approved.loop!.timeZone },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    nextRunAt: 2,
    runs: 0,
    source: "loop-file",
    sourcePath: approved.path,
    sourceDigest: approved.digest,
    loopId: approved.loop!.id,
    trustState: "trusted-current-version",
    trustReceipt: {
      version: 1,
      spaceId: "space-1",
      projectId: "project-1",
      sourceKind: "agents-loop",
      sourceIdentity: approved.path,
      contentDigest: approved.digest,
      semanticDigest: loopSemanticDigest(approved.loop!),
      approvalScope: "current-version",
      approvedAt: 1,
    },
  };
  assert.doesNotThrow(() => assertLoopExecutionTrusted(task, approved, "space-1"));
  assert.throws(
    () => assertLoopExecutionTrusted(task, changed, "space-1"),
    (error: unknown) => (error as { code?: string }).code === "content-trust-changed",
  );
});
''')

# A small architecture note stays after the temporary worker removes itself.
arch = ROOT / "docs/dev/content-trust.md"
arch.parent.mkdir(parents=True, exist_ok=True)
arch.write_text(r'''# Content-bound repository trust

Repository-managed executable instructions are treated as untrusted input. The first consumer is `.agents/loops/*.md`.

- `@polyth/permissions` defines the generic immutable `ContentTrustReceipt`; it binds Space, project, source kind/identity, full content digest, semantic digest, approval scope, and approval time.
- `@polyth/schedule` remains the canonical owner of loop tasks. It embeds a receipt next to the last approved executable snapshot rather than creating another state store.
- Discovery/parsing remains automatic. A new or changed digest is visible as `pendingVersion`, but the task is disabled and the last approved prompt/cadence is not overwritten.
- `trust-current` promotes exactly the re-read digest. `run-once` executes a temporary exact snapshot with a one-shot receipt and leaves persistent trust unchanged. `reject` keeps it blocked.
- The runner re-reads the loop file immediately before dispatch. This closes the scanner interval window for manual edits, agent edits, pulls, checkouts, rebases, merges, and external filesystem changes. Any mismatch fails closed.

This receipt contract is intentionally consumer-neutral so future project commands/tracks can use the same content identity without sharing schedule state.
''')

# This worker and its workflow are implementation scaffolding, never product
# code. Remove them before the workflow commits the verified result.
for temporary in [
    ROOT / "scripts/apply-platform-hardening-p0.py",
    ROOT / ".github/workflows/apply-platform-hardening.yml",
]:
    if temporary.exists():
        temporary.unlink()
