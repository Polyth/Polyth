/** Reflect: turn user corrections from canonical session history into
 * proposed rules the user reviews. Nothing becomes a memory or touches an
 * instruction file without an explicit approval request from the user.
 *
 * Tenant state (proposals, scan cursors) lives in the Space's package
 * directory, keyed by project and person; a foreign Space never resolves the
 * same file. Each person has their own proposals, drawn only from messages
 * they wrote; the project's shared file (the pre-person state, kept as is)
 * holds rules from unauthored messages and system work, and every member
 * sees and decides on it as before. */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import type { RouteHandler, SpaceContext } from "@polyth/contracts";
import { roleAtLeast } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import type { MemoryCategory, MemoryStore } from "@polyth/knowledge";
import { choice, noul, type JudgmentUseDescriptor } from "@polyth/judgment";
import { JUDGMENT_SERVICE, type JudgmentService, type JudgmentUseState } from "@polyth/judgment/server";
import { sanitizeHarvestText } from "./extraction.ts";
import {
  detectCorrections,
  reflectSessionEligible,
  ruleKey,
  sanitizeRule,
  userAuthoredText,
} from "./reflect.ts";
import {
  REFLECT_INSTRUCTION_CONFIRMATION,
  REFLECT_INSTRUCTION_FILES,
  REFLECT_INSTRUCTION_HEADING,
  REFLECT_MEMORY_OFF,
  type ReflectApproveInput,
  type ReflectApproveResult,
  type ReflectDurabilityArea,
  type ReflectInstructionFile,
  type ReflectProposalDto,
  type ReflectViewDto,
} from "./reflectContracts.ts";

export * from "./reflectContracts.ts";

export const REFLECT_DURABILITY_USE_ID = "memory.reflect-durability";
export const REFLECT_DURABILITY_SCOPE = "memory.reflect-durability.v1";

export const REFLECT_DURABILITY_DESCRIPTOR: JudgmentUseDescriptor = {
  id: REFLECT_DURABILITY_USE_ID,
  packageId: "memory",
  title: "Reflect durability filter",
  description: "Evaluates whether user corrections represent lasting preferences rather than one-off instructions.",
  effect: "Hides low-durability proposals from the review list, sorts proposals by durability, and labels each with its area and durability score.",
  scope: REFLECT_DURABILITY_SCOPE,
  evidence: "short",
  defaultEnabled: false,
  params: [
    {
      id: "hideBelow",
      kind: "probability",
      label: "Hide below",
      default: 0.3,
      hint: "Proposals that look less lasting than this are hidden. You can still show and approve them.",
    },
  ],
};

let reflectUseRegistered = false;
let reflectUseUnregister: (() => void) | undefined;

export function ensureReflectDurabilityRegistered(judgment: JudgmentService): void {
  if (reflectUseRegistered) return;
  try {
    reflectUseUnregister = judgment.registerUse(REFLECT_DURABILITY_DESCRIPTOR);
    reflectUseRegistered = true;
  } catch {
    reflectUseRegistered = true;
  }
}

export function unregisterReflectDurability(): void {
  reflectUseUnregister?.();
  reflectUseUnregister = undefined;
  reflectUseRegistered = false;
}

interface ReflectState {
  version: 1;
  projectId: string;
  /** The person whose proposals these are; absent = the project's shared rules. */
  userId?: string;
  enabled: boolean;
  /** Highest canonical event seq already scanned, per session. */
  cursors: Record<string, number>;
  proposals: ReflectProposalDto[];
}

export interface ReflectStoreAccess {
  scope(space: SpaceContext, projectId: string): Promise<{ store: MemoryStore; scope: { spaceId: string; projectId: string; principalId: string } }>;
}

export interface ReflectController {
  kick(sessionId: string): Promise<void>;
  scanProject(space: SpaceContext, projectId: string): Promise<{ added: number; sessions: number }>;
  view(space: SpaceContext, projectId: string): Promise<ReflectViewDto>;
  setEnabled(space: SpaceContext, projectId: string, enabled: boolean): Promise<ReflectViewDto>;
  approve(space: SpaceContext, projectId: string, id: string, input: ReflectApproveInput): Promise<ReflectApproveResult>;
  reject(space: SpaceContext, projectId: string, id: string): Promise<ReflectProposalDto>;
  writeInstruction(space: SpaceContext, projectId: string, id: string, input: ReflectApproveInput): Promise<ReflectApproveResult>;
}

const error = (code: string, message: string): Error => Object.assign(new Error(message), { code });
/** A refusal the host must not mask as a 500: nothing was written, and the
 *  user can fix it (turn memory on), so it is a 409 with a stable code. */
const refused = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code, status: 409, mutationOutcome: "not-started", recovery: "blocked" });
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
const text = (value: unknown): string => typeof value === "string" ? value : "";
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const MAX_PROPOSALS = 400;
const MAX_PENDING = 100;
const FIRST_SCAN_EVENTS = 200;
const PAGE_EVENTS = 200;
const MAX_PAGES_PER_SESSION = 4;
const MAX_SESSIONS_PER_SCAN = 25;
const MAX_INSTRUCTION_BYTES = 1024 * 1024;
const CATEGORIES: readonly MemoryCategory[] = ["decision", "convention", "gotcha", "procedure", "observation"];

const emptyState = (projectId: string, userId?: string): ReflectState =>
  ({ version: 1, projectId, ...(userId ? { userId } : {}), enabled: true, cursors: {}, proposals: [] });

function parseState(raw: string, projectId: string, userId?: string): ReflectState {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return emptyState(projectId, userId); }
  const value = object(parsed);
  // A file is addressed by a project (and person) digest; a mismatch is never adopted.
  if (value.version !== 1 || value.projectId !== projectId || (value.userId ?? undefined) !== userId) return emptyState(projectId, userId);
  const cursors: Record<string, number> = {};
  for (const [key, seq] of Object.entries(object(value.cursors))) if (Number.isSafeInteger(seq)) cursors[key] = seq as number;
  const proposals = Array.isArray(value.proposals)
    ? value.proposals.filter((row): row is ReflectProposalDto => {
      const item = object(row);
      return typeof item.id === "string" && typeof item.rule === "string" && typeof item.sessionId === "string"
        && (item.status === "pending" || item.status === "approved" || item.status === "rejected");
    })
    : [];
  return { version: 1, projectId, ...(userId ? { userId } : {}), enabled: value.enabled !== false, cursors, proposals };
}

/** Bound retained history: pending rows win, then the newest decisions. Old
 * rejected rows also suppress re-proposing the same rule, so trim last. */
function prune(state: ReflectState): void {
  if (state.proposals.length <= MAX_PROPOSALS) return;
  const pending = state.proposals.filter((row) => row.status === "pending").slice(-MAX_PENDING);
  const decided = state.proposals.filter((row) => row.status !== "pending")
    .sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt))
    .slice(0, MAX_PROPOSALS - pending.length);
  state.proposals = [...decided.reverse(), ...pending];
}

const insidePath = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
};

/** Confined write of one bullet under the managed heading. The file name is an
 * allowlisted basename, the real project root is resolved first, and a
 * symlinked instruction file or parent escape is rejected rather than
 * followed; every open uses O_NOFOLLOW so a swapped-in link fails closed. */
export async function appendInstructionRule(projectRoot: string, file: string, rule: string): Promise<{ status: "appended" | "duplicate"; path: string }> {
  if (!(REFLECT_INSTRUCTION_FILES as readonly string[]).includes(file)) throw error("invalid-input", "instruction file is not allowed");
  const line = sanitizeRule(rule);
  if (!line) throw error("invalid-input", "rule is empty or unsafe");
  let root: string;
  try { root = await realpath(projectRoot); } catch { throw error("not-found", "project root is unavailable"); }
  const target = join(root, file);
  if (!insidePath(root, target) || dirname(target) !== root) throw error("invalid-path", "instruction file escapes the project root");
  let existing = "";
  let exists = false;
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw error("invalid-path", "instruction file is a symbolic link");
    if (!info.isFile()) throw error("invalid-path", "instruction file is not a regular file");
    if (info.size > MAX_INSTRUCTION_BYTES) throw error("invalid-input", "instruction file is too large");
    exists = true;
  } catch (cause) {
    if (object(cause).code !== "ENOENT") throw cause;
  }
  const flags = fsConstants.O_NOFOLLOW ?? 0;
  if (exists) {
    const handle = await open(target, fsConstants.O_RDONLY | flags);
    try { existing = await handle.readFile("utf8"); } finally { await handle.close(); }
  }
  const bullet = `- ${line}`;
  const lines = existing.split("\n");
  if (lines.some((row) => row.trim() === bullet)) return { status: "duplicate", path: target };
  let next: string;
  const headingIndex = lines.findIndex((row) => row.trim() === REFLECT_INSTRUCTION_HEADING);
  if (headingIndex < 0) {
    const base = existing.replace(/\s*$/, "");
    next = `${base}${base ? "\n\n" : ""}${REFLECT_INSTRUCTION_HEADING}\n\n${bullet}\n`;
  } else {
    // Insert after the section's last non-blank line, before the next heading.
    let end = lines.length;
    for (let index = headingIndex + 1; index < lines.length; index++) {
      if (/^#{1,2}\s/.test(lines[index]!)) { end = index; break; }
    }
    let insertAt = end;
    while (insertAt > headingIndex + 1 && lines[insertAt - 1]!.trim() === "") insertAt--;
    const before = lines.slice(0, insertAt);
    if (insertAt === headingIndex + 1) before.push("");
    const after = lines.slice(insertAt);
    next = [...before, bullet, ...(after.length && after[0]!.trim() !== "" ? [""] : []), ...after].join("\n");
    if (!next.endsWith("\n")) next += "\n";
  }
  // In-place write keeps the inode; O_NOFOLLOW refuses a link created since lstat.
  const handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | flags, 0o644);
  try { await handle.writeFile(next, "utf8"); } finally { await handle.close(); }
  return { status: "appended", path: target };
}

/** The signed-in person a route acts for; server work has none. */
export const personOf = (space: SpaceContext): string | undefined =>
  space.userId && !space.userId.startsWith("system:")
    && (space as { authority?: { kind?: unknown } }).authority?.kind !== "system"
    ? space.userId
    : undefined;

/** Who wrote a canonical event, if anyone. */
const authorOf = (event: { data?: unknown }): string | undefined => {
  const userId = object(object(event.data).author).userId;
  return typeof userId === "string" && userId ? userId : undefined;
};

export function createReflectController(host: ServerPackageHost, access: ReflectStoreAccess): ReflectController {
  const locks = new Map<string, Promise<unknown>>();
  // The shared file keeps its pre-person address, so existing state stays the
  // project's shared rules.
  const fileFor = (space: SpaceContext, projectId: string, userId?: string): string =>
    join(host.spaceStorage(space).packageDir("memory"), "reflect",
      `${digest(userId ? `${space.spaceId}\0${projectId}\0person\0${userId}` : `${space.spaceId}\0${projectId}`)}.json`);

  const load = async (space: SpaceContext, projectId: string, userId?: string): Promise<ReflectState> => {
    try { return parseState(await readFile(fileFor(space, projectId, userId), "utf8"), projectId, userId); }
    catch (cause) {
      if (object(cause).code !== "ENOENT") throw cause;
      // A person's first state starts from the project's detection switch.
      const fresh = emptyState(projectId, userId);
      if (userId) fresh.enabled = (await load(space, projectId)).enabled;
      return fresh;
    }
  };
  const save = async (file: string, state: ReflectState): Promise<void> => {
    prune(state);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    await rename(temp, file);
  };
  /** Serialize read-modify-write per Space/project(/person) file. */
  const withState = async <T>(space: SpaceContext, projectId: string, mutate: (state: ReflectState) => Promise<T> | T, write = true, userId?: string): Promise<T> => {
    // Admission: the scoped facade rejects a foreign or unknown project before
    // any tenant file path is derived from the request.
    await access.scope(space, projectId);
    const file = fileFor(space, projectId, userId);
    const previous = locks.get(file) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chained = previous.then(() => current);
    locks.set(file, chained);
    await previous.catch(() => undefined);
    try {
      const state = await load(space, projectId, userId);
      const result = await mutate(state);
      if (write) await save(file, state);
      return result;
    } finally {
      release();
      if (locks.get(file) === chained) locks.delete(file);
    }
  };

  const projectRootFor = async (space: SpaceContext, projectId: string): Promise<string | undefined> => {
    const project = await host.forSpace(space).projects.get(projectId);
    if (!project || project.remote || !project.path) return undefined;
    return project.path;
  };

  const judgeCandidate = async (
    space: SpaceContext,
    projectId: string,
    sessionId: string,
    rule: string,
  ): Promise<{ durability: number; area: ReflectDurabilityArea } | undefined> => {
    const judgment = host.services?.get ? host.services.get(JUDGMENT_SERVICE) : undefined;
    if (!judgment) return undefined;
    ensureReflectDurabilityRegistered(judgment);

    try {
      const use = await judgment.resolveUse({ space, projectId }, REFLECT_DURABILITY_USE_ID);
      if (!use.enabled) return undefined;

      const evidence = sanitizeHarvestText(rule)?.slice(0, 400).trim();
      if (!evidence) return undefined;

      const run = await judgment.createRun({ space, projectId });
      try {
        const result = await run.judge({
          scope: REFLECT_DURABILITY_SCOPE,
          state: evidence,
          questions: {
            durability: noul("Is this a lasting preference or rule rather than a one-off instruction?"),
            area: choice("What area does this instruction or rule apply to?", {
              code: "Code and implementation",
              style: "Coding style and conventions",
              process: "Development workflow and testing",
              communication: "Communication and response style",
              other: "Other rules or preferences",
            }),
          },
          metadata: {
            sessionId,
            projectId,
          },
        });

        if (result.ok) {
          const durability = result.answers.durability.probability;
          const area = result.answers.area.value as ReflectDurabilityArea;
          if (typeof durability === "number" && Number.isFinite(durability)) {
            return { durability, area };
          }
        }
        return undefined;
      } finally {
        run.dispose();
      }
    } catch {
      return undefined;
    }
  };

  /** Scan one session into `state`: only messages its person wrote (none: unauthored ones). */
  const scanSession = async (
    space: SpaceContext,
    state: ReflectState,
    session: { id: string; title?: string; parentId?: string; historyImport?: unknown },
    alsoKnown: readonly ReflectProposalDto[] = [],
  ): Promise<number> => {
    if (!reflectSessionEligible(session)) return 0;
    let cursor = state.cursors[session.id];
    if (cursor === undefined) {
      // First sight starts from a bounded recent window, never the whole log.
      const latest = await host.store.latestSeq(session.id).catch(() => 0);
      cursor = Math.max(0, latest - FIRST_SCAN_EVENTS);
    }
    const known = new Set([...state.proposals, ...alsoKnown].map((row) => ruleKey(row.rule)));
    let added = 0;
    for (let page = 0; page < MAX_PAGES_PER_SESSION; page++) {
      const events = await host.forSpace(space).sessions.events(session.id, cursor, { limit: PAGE_EVENTS });
      const ordered = events.filter((event) => event.seq > cursor!).sort((a, b) => a.seq - b.seq);
      if (!ordered.length) break;
      for (const event of ordered) {
        cursor = event.seq;
        if (authorOf(event) !== state.userId) continue;
        const authored = userAuthoredText(event);
        if (!authored) continue;
        for (const detection of detectCorrections(authored)) {
          const key = ruleKey(detection.rule);
          if (known.has(key)) continue;
          if (state.proposals.filter((row) => row.status === "pending").length >= MAX_PENDING) break;
          known.add(key);
          const judged = await judgeCandidate(space, state.projectId, session.id, detection.rule);
          state.proposals.push({
            id: randomUUID(),
            projectId: state.projectId,
            sessionId: session.id,
            ...(session.title ? { sessionTitle: session.title.slice(0, 160) } : {}),
            eventSeq: event.seq,
            ...(event.id ? { eventId: event.id } : {}),
            signal: detection.signal,
            rule: detection.rule,
            status: "pending",
            createdAt: Date.now(),
            ...(judged ? {
              durability: judged.durability,
              area: judged.area,
              judgment: {
                durability: judged.durability,
                area: judged.area,
                evaluatedAt: Date.now(),
              },
            } : {}),
          });
          added++;
        }
      }
      if (ordered.length < PAGE_EVENTS) break;
    }
    state.cursors[session.id] = cursor;
    return added;
  };

  const policyAllowsScan = async (space: SpaceContext, projectId: string): Promise<boolean> => {
    const { store, scope } = await access.scope(space, projectId);
    return store.getPolicy(scope).mode !== "off";
  };

  const view = async (
    space: SpaceContext,
    state: ReflectState,
    files: ReflectViewDto["instructionFiles"],
    writable: boolean,
    memoryOff: boolean,
  ): Promise<ReflectViewDto> => {
    let use: JudgmentUseState | undefined;
    const judgment = host.services?.get ? host.services.get(JUDGMENT_SERVICE) : undefined;
    if (judgment) {
      ensureReflectDurabilityRegistered(judgment);
      try {
        use = await judgment.resolveUse({ space, projectId: state.projectId }, REFLECT_DURABILITY_USE_ID);
      } catch {
        use = undefined;
      }
    }

    const pending = state.proposals.filter((row) => row.status === "pending");
    const recent = state.proposals.filter((row) => row.status !== "pending")
      .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0)).slice(0, 10);

    // If judgment is off, disabled or service is unavailable -> exactly today's behavior
    if (!use || !use.enabled) {
      return {
        projectId: state.projectId,
        enabled: state.enabled,
        pending: pending.slice(-50).reverse(),
        pendingTotal: pending.length,
        recent,
        instructionFiles: files,
        instructionWritable: writable,
        memoryOff,
      };
    }

    const hideBelow = typeof use.params.hideBelow === "number" ? use.params.hideBelow : 0.3;
    const isHidden = (row: ReflectProposalDto): boolean =>
      typeof row.durability === "number" && row.durability < hideBelow;

    const visiblePending = pending.filter((row) => !isHidden(row));
    const hiddenPending = pending.filter(isHidden);

    const sortByDurability = (a: ReflectProposalDto, b: ReflectProposalDto): number => {
      const da = typeof a.durability === "number" ? a.durability : -1;
      const db = typeof b.durability === "number" ? b.durability : -1;
      if (db !== da) return db - da; // highest durability first
      return (b.createdAt ?? 0) - (a.createdAt ?? 0); // newest first if tied
    };

    visiblePending.sort(sortByDurability);
    hiddenPending.sort(sortByDurability);

    return {
      projectId: state.projectId,
      enabled: state.enabled,
      pending: visiblePending.slice(0, 50),
      pendingTotal: visiblePending.length,
      hidden: hiddenPending.slice(0, 50),
      hiddenTotal: hiddenPending.length,
      recent,
      instructionFiles: files,
      instructionWritable: writable,
      memoryOff,
    };
  };

  const instructionInventory = async (space: SpaceContext, projectId: string) => {
    const root = await projectRootFor(space, projectId);
    if (!root) return { files: REFLECT_INSTRUCTION_FILES.map((file) => ({ file, exists: false })), writable: false };
    let real: string;
    try { real = await realpath(root); } catch { return { files: REFLECT_INSTRUCTION_FILES.map((file) => ({ file, exists: false })), writable: false }; }
    const files = await Promise.all(REFLECT_INSTRUCTION_FILES.map(async (file) => {
      try { const info = await lstat(join(real, file)); return { file, exists: info.isFile() }; } catch { return { file, exists: false }; }
    }));
    return { files, writable: true };
  };

  const decide = (state: ReflectState, id: string): ReflectProposalDto => {
    const proposal = state.proposals.find((row) => row.id === id);
    if (!proposal) throw error("not-found", "proposal not found");
    return proposal;
  };

  /** Validate an instruction request before any durable change. The
   * confirmation token is set only by the explicit UI action; a missing token
   * never degrades to a silent write. */
  const instructionRequest = (input: ReflectApproveInput): string | undefined => {
    const file = text(input.instructionFile);
    if (!file) return undefined;
    if (input.confirmation !== REFLECT_INSTRUCTION_CONFIRMATION) throw error("invalid-input", "instruction file write requires explicit confirmation");
    if (!(REFLECT_INSTRUCTION_FILES as readonly string[]).includes(file)) throw error("invalid-input", "instruction file is not allowed");
    return file;
  };

  const writeApproved = async (space: SpaceContext, projectId: string, proposal: ReflectProposalDto, input: ReflectApproveInput): Promise<ReflectApproveResult["instruction"]> => {
    const file = instructionRequest(input);
    if (!file) return undefined;
    const root = await projectRootFor(space, projectId);
    if (!root) return { status: "failed", file, code: "unsupported" };
    try {
      const result = await appendInstructionRule(root, file, proposal.rule);
      proposal.instruction = { file: file as ReflectInstructionFile, at: Date.now() };
      return result.status === "appended" ? { status: "appended", file: file as ReflectInstructionFile } : { status: "duplicate", file: file as ReflectInstructionFile };
    } catch (cause) {
      const code = text(object(cause).code);
      return { status: "failed", file, code: code === "invalid-path" || code === "invalid-input" || code === "not-found" ? code : "write-failed" };
    }
  };

  /** A person's own proposals plus the project's shared ones, for display. */
  const withShared = async (space: SpaceContext, projectId: string, own: ReflectState): Promise<ReflectState> => {
    if (!own.userId) return own;
    const shared = await load(space, projectId);
    return { ...own, proposals: [...own.proposals, ...shared.proposals] };
  };
  /** Whose file holds a proposal the caller decides on: theirs, else the shared one. */
  const holderOf = async (space: SpaceContext, projectId: string, id: string): Promise<string | undefined> => {
    const person = personOf(space);
    if (!person) return undefined;
    await access.scope(space, projectId);
    return (await load(space, projectId, person)).proposals.some((row) => row.id === id) ? person : undefined;
  };

  return {
    async kick(sessionId) {
      const projection = await host.store.projection(sessionId);
      if (!projection?.spaceId || !projection.projectId) return;
      const space = host.systemSpaceContext(projection.spaceId);
      if (!await policyAllowsScan(space, projection.projectId)) return;
      // The turn's person gets proposals from what they wrote; a session no
      // person acts for adds only to the project's shared rules.
      const actor = projection.actor?.userId;
      if (actor && host.people && !host.people.isMember(actor, projection.spaceId)) return;
      const shared = actor ? await load(space, projection.projectId) : undefined;
      await withState(space, projection.projectId, async (state) => {
        if (!state.enabled) return;
        await scanSession(space, state, projection, shared?.proposals);
      }, true, actor);
    },
    async scanProject(space, projectId) {
      if (!await policyAllowsScan(space, projectId)) throw refused(REFLECT_MEMORY_OFF, "Project memory is off, so sessions are not scanned. Turn memory on in Delivery policy.");
      const sessions = (await host.forSpace(space).sessions.list(projectId))
        .filter(reflectSessionEligible)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, MAX_SESSIONS_PER_SCAN);
      const person = personOf(space);
      // Unauthored messages (written before authorship) keep feeding the shared rules.
      let added = await withState(space, projectId, async (state) => {
        let count = 0;
        for (const session of sessions) count += await scanSession(space, state, session);
        return count;
      });
      if (person) {
        const shared = await load(space, projectId);
        added += await withState(space, projectId, async (state) => {
          let count = 0;
          for (const session of sessions) count += await scanSession(space, state, session, shared.proposals);
          return count;
        }, true, person);
      }
      return { added, sessions: sessions.length };
    },
    async view(space, projectId) {
      const inventory = await instructionInventory(space, projectId);
      const memoryOff = !await policyAllowsScan(space, projectId);
      return withState(space, projectId, async (state) =>
        view(space, await withShared(space, projectId, state), inventory.files, inventory.writable, memoryOff), false, personOf(space));
    },
    async setEnabled(space, projectId, enabled) {
      const inventory = await instructionInventory(space, projectId);
      const memoryOff = !await policyAllowsScan(space, projectId);
      const person = personOf(space);
      // The shared rules' switch is the project's: Space admins and server work.
      if (!person || roleAtLeast(space.role, "admin")) await withState(space, projectId, (state) => { state.enabled = enabled; });
      if (!person) return withState(space, projectId, (state) => view(space, state, inventory.files, inventory.writable, memoryOff), false);
      return withState(space, projectId, async (state) => {
        state.enabled = enabled;
        return view(space, await withShared(space, projectId, state), inventory.files, inventory.writable, memoryOff);
      }, true, person);
    },
    async approve(space, projectId, id, input) {
      const { store, scope } = await access.scope(space, projectId);
      return withState(space, projectId, async (state) => {
        const proposal = decide(state, id);
        if (proposal.status === "rejected") throw error("conflict", "proposal was rejected");
        instructionRequest(input);
        // An approved rule is already a memory; edit that memory instead.
        if (input.rule !== undefined && proposal.status === "pending") {
          const edited = sanitizeRule(input.rule);
          if (!edited) throw error("invalid-input", "rule is empty, too long, or unsafe");
          proposal.rule = edited;
        }
        if (proposal.status === "pending") {
          const title = sanitizeRule(input.title) ?? (proposal.rule.length > 80 ? `${proposal.rule.slice(0, 79)}…` : proposal.rule);
          const category = input.category && CATEGORIES.includes(input.category) ? input.category : "convention";
          const receipt = store.create(scope, {
            projectId,
            title,
            body: proposal.rule,
            category,
            tags: ["reflect", proposal.signal],
            lifecycle: "active",
            evidence: "user-stated",
            freshness: "current",
            pinned: false,
            userLocked: true,
            sources: [{ kind: "session", sessionId: proposal.sessionId, startSeq: proposal.eventSeq, endSeq: proposal.eventSeq }],
            idempotencyKey: `reflect:${proposal.id}`,
            requestFingerprint: digest(`${title}\0${proposal.rule}\0${category}`),
          }, { authoredBy: { kind: "system", via: "reflect" }, ...(personOf(space) ? { approver: { userId: personOf(space)! } } : {}) });
          if (receipt.status !== "committed" && receipt.status !== "duplicate") throw receipt.status === "conflict" ? error("conflict", receipt.message ?? "memory was not saved") : refused("memory-blocked", receipt.message ?? "memory was not saved");
          proposal.status = "approved";
          proposal.decidedAt = Date.now();
          if (receipt.memoryId) proposal.memoryId = receipt.memoryId;
        }
        const instruction = await writeApproved(space, projectId, proposal, input);
        return { proposal: { ...proposal }, ...(proposal.memoryId ? { memoryId: proposal.memoryId } : {}), ...(instruction ? { instruction } : {}) };
      }, true, await holderOf(space, projectId, id));
    },
    async reject(space, projectId, id) {
      return withState(space, projectId, (state) => {
        const proposal = decide(state, id);
        if (proposal.status === "approved") throw error("conflict", "proposal was already approved");
        proposal.status = "rejected";
        proposal.decidedAt = Date.now();
        return { ...proposal };
      }, true, await holderOf(space, projectId, id));
    },
    async writeInstruction(space, projectId, id, input) {
      return withState(space, projectId, async (state) => {
        const proposal = decide(state, id);
        if (proposal.status !== "approved") throw error("conflict", "approve the rule before writing it to an instruction file");
        if (!text(input.instructionFile)) throw error("invalid-input", "instruction file is required");
        const instruction = await writeApproved(space, projectId, proposal, input);
        return { proposal: { ...proposal }, ...(proposal.memoryId ? { memoryId: proposal.memoryId } : {}), ...(instruction ? { instruction } : {}) };
      }, true, await holderOf(space, projectId, id));
    },
  };
}

/** `/api/memory/reflect*` routes. Reads need project admission; every write
 * also needs Space member access, matching the rest of memory management. */
export function reflectRoutes(controller: ReflectController): RouteHandler {
  const write = (space: SpaceContext): void => {
    if (!roleAtLeast(space.role, "member")) throw error("forbidden", "memory management requires Space member access");
  };
  const projectOf = (value: unknown): string => {
    const projectId = text(value).trim();
    if (!projectId) throw error("invalid-input", "projectId is required");
    return projectId;
  };
  return async (rc) => {
    if (rc.path !== "/api/memory/reflect" && !rc.path.startsWith("/api/memory/reflect/")) return false;
    if (rc.path === "/api/memory/reflect" && rc.method === "GET") {
      rc.json(200, await controller.view(rc.space, projectOf(rc.url.searchParams.get("projectId"))));
      return true;
    }
    if (rc.method !== "POST" && rc.method !== "PUT") return false;
    write(rc.space);
    const input = await rc.body();
    const projectId = projectOf(input.projectId);
    if (rc.path === "/api/memory/reflect/settings" && rc.method === "PUT") {
      rc.json(200, await controller.setEnabled(rc.space, projectId, input.enabled !== false));
      return true;
    }
    if (rc.path === "/api/memory/reflect/scan" && rc.method === "POST") {
      rc.json(200, await controller.scanProject(rc.space, projectId));
      return true;
    }
    const match = rc.path.match(/^\/api\/memory\/reflect\/([^/]+)\/(approve|reject|instruction)$/);
    if (!match || rc.method !== "POST") return false;
    const id = decodeURIComponent(match[1]!);
    const decision: ReflectApproveInput = {
      ...(typeof input.rule === "string" ? { rule: input.rule } : {}),
      ...(typeof input.title === "string" ? { title: input.title } : {}),
      ...(typeof input.category === "string" ? { category: input.category as MemoryCategory } : {}),
      ...(typeof input.instructionFile === "string" ? { instructionFile: input.instructionFile } : {}),
      ...(typeof input.confirmation === "string" ? { confirmation: input.confirmation } : {}),
    };
    if (match[2] === "reject") rc.json(200, await controller.reject(rc.space, projectId, id));
    else if (match[2] === "approve") rc.json(200, await controller.approve(rc.space, projectId, id, decision));
    else rc.json(200, await controller.writeInstruction(rc.space, projectId, id, decision));
    return true;
  };
}
