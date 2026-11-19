// Background shells OpenCode runs for a session (`shell` tool, `background:
// true`) and reports back to the model on its own. Polyth must know the live
// set (the server holds the runtime while it is non-empty), wake the session
// itself when a shell settles while no Polyth turn runs, and say so when the
// shells are provably gone.
//
// Evidence (OpenCode v2.2.6 bundled binary, source-inspected, not live-run):
//  - The shell tool creates the shell with `metadata: { sessionID }`, so
//    `Shell.Info.metadata.sessionID` names the starting session. Events
//    `shell.created {info}`, `shell.exited {id, exit?, status}` and
//    `shell.deleted {id}` carry no session of their own; `shell.exited` is
//    therefore resolved through the id seen in `shell.created` / `GET /api/shell`.
//  - On completion the tool posts a `session.synthetic` message for that
//    session (the "notification"). Whether that starts an execution loop by
//    itself (`resume` default) was NOT determinable from the binary; the
//    adapter treats any unadmitted execution right after a wake as that loop.
//  - Legacy (non-V2) servers expose no shell events; nothing is tracked there.

import type { RuntimeBackgroundTask, RuntimeEvent } from "@polyth/contracts";

export const SHELL_DESCRIPTION_LIMIT = 200;

export interface ShellRecord {
  id: string;
  status: string;
  command: string;
  file?: string;
  exit?: number;
  sessionId?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** One Shell.Info row; `undefined` when it is not a recognisable shell. */
export const shellOf = (value: unknown): ShellRecord | undefined => {
  const info = asRecord(value);
  if (!info || typeof info.id !== "string" || !info.id) return undefined;
  const sessionId = asRecord(info.metadata)?.sessionID;
  return {
    id: info.id,
    status: typeof info.status === "string" ? info.status : "running",
    command: typeof info.command === "string" ? info.command : "",
    ...(typeof info.file === "string" && info.file ? { file: info.file } : {}),
    ...(typeof info.exit === "number" ? { exit: info.exit } : {}),
    ...(typeof sessionId === "string" && sessionId ? { sessionId } : {}),
  };
};

/** Single line, bounded: what the Polyth UI shows for a background task. */
export const shellDescription = (command: string): string => {
  const line = command.replace(/\s+/g, " ").trim();
  return line.length > SHELL_DESCRIPTION_LIMIT ? `${line.slice(0, SHELL_DESCRIPTION_LIMIT - 1)}…` : line;
};

export const shellWakeText = (shell: ShellRecord, status: string, exit: number | undefined): string => [
  "A background shell command you started has finished while no turn was running.",
  `Shell: ${shell.id}`,
  ...(shell.command ? [`Command: ${shellDescription(shell.command)}`] : []),
  `Status: ${status}`,
  ...(exit !== undefined ? [`Exit code: ${exit}`] : []),
  ...(shell.file ? [`Output file: ${shell.file}`] : []),
  "",
  "Read its result and continue your task.",
].join("\n");

interface Tracked {
  canonical: string;
  record: ShellRecord;
}

export interface BackgroundShellDeps {
  /** Canonical session of a native session id, when this runtime maps it. */
  canonicalOf(backendSessionId: string): string | undefined;
  /** A Polyth turn is currently admitted for the session. */
  turnAdmitted(canonical: string): boolean;
  emit(canonical: string, event: RuntimeEvent): void;
  /** A wake was handed to Polyth: OpenCode's own delivery loop must not run. */
  onWake?(canonical: string, shellId: string): void;
}

export interface BackgroundShells {
  created(info: unknown): void;
  exited(event: { id?: unknown; status?: unknown; exit?: unknown }): void;
  deleted(id: unknown): void;
  /** Reconcile against a full `shell.list`. Missing shells are lost. */
  reconcile(list: unknown[]): void;
  /** The server generation changed or the process exited: the shells are gone. */
  lose(): void;
  /** The authority/generation the set belongs to; a change proves loss. */
  generation(key: string): void;
  size(): number;
}

export const createBackgroundShells = (deps: BackgroundShellDeps): BackgroundShells => {
  const tracked = new Map<string, Tracked>();
  const woken = new Set<string>();
  let generationKey: string | undefined;

  const tasksOf = (canonical: string): RuntimeBackgroundTask[] =>
    [...tracked.values()]
      .filter((entry) => entry.canonical === canonical)
      .map(({ record }) => ({
        id: record.id,
        ...(shellDescription(record.command) ? { description: shellDescription(record.command) } : {}),
        kind: "shell",
      }));
  const publish = (canonical: string, lost?: RuntimeBackgroundTask[]): void => {
    deps.emit(canonical, {
      type: "runtime/background-tasks",
      tasks: tasksOf(canonical),
      ...(lost?.length ? { lost } : {}),
    });
  };
  const add = (record: ShellRecord): string | undefined => {
    if (record.status !== "running" || !record.sessionId) return undefined;
    const canonical = deps.canonicalOf(record.sessionId);
    if (!canonical) return undefined;
    if (tracked.has(record.id)) return undefined;
    tracked.set(record.id, { canonical, record });
    return canonical;
  };
  const settle = (id: string, status: string, exit: number | undefined): void => {
    const entry = tracked.get(id);
    if (!entry) return;
    tracked.delete(id);
    publish(entry.canonical);
    // Inside an admitted turn OpenCode folds the notification into that turn.
    if (deps.turnAdmitted(entry.canonical) || woken.has(id)) return;
    woken.add(id);
    if (woken.size > 512) woken.delete(woken.values().next().value!);
    deps.onWake?.(entry.canonical, id);
    deps.emit(entry.canonical, {
      type: "runtime/wake-requested",
      wakeId: `opencode-shell:${id}`,
      reason: "background-task",
      text: shellWakeText(entry.record, status, exit),
    });
  };
  const loseWhere = (match: (entry: Tracked) => boolean): void => {
    const bySession = new Map<string, RuntimeBackgroundTask[]>();
    for (const [id, entry] of [...tracked]) {
      if (!match(entry)) continue;
      tracked.delete(id);
      const list = bySession.get(entry.canonical) ?? [];
      list.push({
        id,
        ...(shellDescription(entry.record.command) ? { description: shellDescription(entry.record.command) } : {}),
        kind: "shell",
      });
      bySession.set(entry.canonical, list);
    }
    for (const [canonical, lost] of bySession) publish(canonical, lost);
  };

  return {
    created(info) {
      const record = shellOf(info);
      if (!record) return;
      const canonical = add(record);
      if (canonical) publish(canonical);
    },
    exited(event) {
      if (typeof event.id !== "string") return;
      settle(
        event.id,
        typeof event.status === "string" ? event.status : "exited",
        typeof event.exit === "number" ? event.exit : undefined,
      );
    },
    deleted(id) {
      if (typeof id !== "string") return;
      const entry = tracked.get(id);
      if (!entry) return;
      tracked.delete(id);
      publish(entry.canonical);
    },
    reconcile(list) {
      const rows = new Map<string, ShellRecord>();
      for (const row of list) {
        const record = shellOf(row);
        if (record) rows.set(record.id, record);
      }
      // Missing from a successful full listing: proven gone, not merely quiet.
      loseWhere((entry) => !rows.has(entry.record.id));
      const touched = new Set<string>();
      for (const record of rows.values()) {
        if (tracked.has(record.id)) {
          if (record.status !== "running") settle(record.id, record.status, record.exit);
          continue;
        }
        const canonical = add(record);
        if (canonical) touched.add(canonical);
      }
      for (const canonical of touched) publish(canonical);
    },
    lose() {
      loseWhere(() => true);
    },
    generation(key) {
      const previous = generationKey;
      generationKey = key;
      if (previous !== undefined && previous !== key) loseWhere(() => true);
    },
    size: () => tracked.size,
  };
};
