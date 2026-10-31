import { join } from "node:path";
import type { JsonObject, SessionEvent, SessionProjection, SessionService, SpaceContext } from "@polyth/contracts";
import {
  localOnlyRemoteAccess, SERVER_MODEL_ROUTING, SERVER_PERMISSION_WAITING_BUS, SERVER_SESSION_ISOLATION, SERVER_TURN_COMPLETION_BUS,
  SERVER_TURN_STOPPED_BUS, SESSION_ATTENTION_SERVICE, systemSessionsForSession, type ServerPackage, type ServerPackageHost,
} from "@polyth/plugins";
import { sessionCacheFacts } from "@polyth/usage/session-cache";
import { JUDGMENT_SERVICE, type JudgmentService } from "@polyth/judgment/server";
import type { JudgmentQuestion, JudgmentResult } from "@polyth/judgment";
import { BUILTIN_USES, runCompletionCheck, runNeedsYou } from "./builtins.ts";
import { cacheIneligible, createKeepWarm, judgeContinuation, KEEP_ALIVE_PROMPT, KEEP_WARM, keepAliveBudget, keepWarmParams } from "./keepWarm.ts";
import { askJudge, assessmentFor, customScope, judgeTarget, requestVerdict, type CustomOutcome } from "./custom.ts";
import { ACTS_FOR_NO_ONE, runAction, sendBlocked, sendMessage, SPACE_NEVER_APPROVES, type ActionTarget } from "./actions.ts";
import { currentRoute, routeAsk, routeDecision, routeOptions } from "./routes.ts";
import {
  completedTurns, currentTurnEvidence, isKeepAlive, latestTurnEvidence, mirroredRequestOpen, permissionEvidence, type TurnEvidence,
} from "./evidence.ts";
import { createJudge, deleteJudge, noteOutcome, readJudges, reserveCall, updateJudge, usageToday } from "./store.ts";
import {
  ASSESSMENT_EVENT, decidesRequests, hasActions, JUDGE_ID, MAX_BACKTEST, PACKAGE_ID, REQUEST_CHECK_EVENT, REQUEST_VERDICT_EVENT, routeKey,
  validateJudgeInput, type AssessmentAction, type AssessmentData, type BacktestRow, type JudgeDefinition, type JudgeRoutesSnapshot, type JudgesSnapshot,
  type JudgeTrigger, type RequestCheckData, type RequestVerdictData, type RequestVerdictKind,
} from "./types.ts";

/** Background evaluations in flight at once; a newer event of the same kind replaces a queued one. */
const MAX_ACTIVE = 4;
/** How often armed chats are checked for a due keep-alive. */
const KEEP_WARM_TICK_MS = 15_000;
/** Remembered (session, request) and (session, limit) evaluations, so a repeated event asks once. */
const MAX_SEEN = 1_000;

/** A signed-in person, not server work: only a person can lend a judge their access. */
const isPerson = (space: SpaceContext): boolean =>
  Boolean(space.userId) && !space.userId.startsWith("system:")
  && (space as { authority?: { kind?: unknown } }).authority?.kind !== "system";
const forbidden = (message: string) => Object.assign(new Error(message), { code: "forbidden" });

/** How an owned judge reads and acts: its owner's own facade, and context for their model shortlist. */
interface OwnerAccess { sessions?: SessionService; space?: SpaceContext }

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  let enabled = false;
  let generation = 0;
  let subscriptions: Array<{ dispose(): void }> = [];
  let lifetime = new AbortController();
  const dir = (space: SpaceContext) => host.spaceStorage(space).packageDir(PACKAGE_ID);
  const judgesFile = (space: SpaceContext) => join(dir(space), "judges.json");
  const usageFile = (space: SpaceContext) => join(dir(space), "usage.json");

  // Judgment may enable before or after this package, or be replaced: register uses lazily and follow the live service.
  let registered: { service: JudgmentService; off: Array<() => void> } | undefined;
  const judgment = (): JudgmentService | undefined => {
    const service = enabled ? host.services.get(JUDGMENT_SERVICE) : undefined;
    if (registered && registered.service !== service) { registered.off.forEach((off) => off()); registered = undefined; }
    if (service && !registered) {
      const off: Array<() => void> = [];
      for (const use of [...BUILTIN_USES, KEEP_WARM]) {
        try { off.push(service.registerUse(use)); }
        catch (error) { console.warn(`[polyth] judges: Judgment use ${use.id} registration failed`, error); }
      }
      registered = { service, off };
    }
    return service;
  };

  const record = async (sessionId: string, data: AssessmentData) => {
    // Ignorable: never part of model history. Persisted first, then broadcast by the host.
    await host.events.append(sessionId, ASSESSMENT_EVENT, data as unknown as JsonObject, { ignorable: true, producerPlugin: PACKAGE_ID });
    // Durable first; the notification only raises an idle chat's priority.
    if (data.attention) host.services.get(SESSION_ATTENTION_SERVICE)?.waitingForPerson(sessionId);
  };

  /**
   * A note for the request's card (a judge checking it, getting no answer, or
   * its verdict), while the request still waits: one already answered has no
   * card left to tell. A delegated child's card is mirrored in its parent
   * chat, so a still-open mirror gets a copy naming the child, as the request
   * itself does, when the judge's owner can open that chat too.
   */
  const recordForCard = async (projection: SessionProjection & { spaceId: string }, judge: JudgeDefinition, type: string,
    data: RequestVerdictData | RequestCheckData) => {
    if (!permissionEvidence(await host.store.events(projection.id), data.requestId)?.open) return;
    await host.events.append(projection.id, type, data as unknown as JsonObject, { ignorable: true, producerPlugin: PACKAGE_ID });
    const parentId = projection.parentId;
    if (!parentId) return;
    try {
      if (!mirroredRequestOpen(await host.store.events(parentId), data.requestId, projection.id)) return;
      if (!await ownerAccess(judge, projection.spaceId, parentId)) return;
      await host.events.append(parentId, type, { ...data, sourceSessionId: projection.id } as unknown as JsonObject,
        { ignorable: true, producerPlugin: PACKAGE_ID });
    } catch (error) { console.warn("[polyth] judges: card note not copied to the parent chat", error); }
  };

  /**
   * An owned judge sees only the chats its owner can open, and acts through
   * that person's facade. Undefined: the owner cannot open this chat or left
   * the Space, so the judge neither reads nor acts. A judge saved before
   * ownership (or by server work) keeps marking every chat and cannot act.
   */
  const ownerAccess = async (judge: JudgeDefinition, spaceId: string, sessionId: string): Promise<OwnerAccess | undefined> => {
    if (!judge.ownerUserId || !host.personSpaceContext) return {};
    const space = host.personSpaceContext(judge.ownerUserId, spaceId);
    if (!space) return undefined;
    const sessions = host.forSpace(space).sessions;
    try { await sessions.snapshot(sessionId); } catch { return undefined; }
    return { sessions, space };
  };

  const judgesOf = (space: SpaceContext, trigger: JudgeTrigger, projectId: string): JudgeDefinition[] => {
    try {
      return readJudges(judgesFile(space)).judges.filter((judge) => judge.enabled && judge.trigger === trigger
        && (!judge.filters.projectId || judge.filters.projectId === projectId));
    } catch (error) { console.warn("[polyth] judges: stored judges unreadable", error); return []; }
  };

  /**
   * A call that got no answer is never a decision, but it must not be silent:
   * the judge's row in Settings shows the reason until its next answer.
   */
  const noteCall = (space: SpaceContext, judge: JudgeDefinition, failure: string | undefined) => {
    if (failure) console.warn("[polyth] judges: judge got no answer", JSON.stringify({ judgeId: judge.id, trigger: judge.trigger, reason: failure }));
    try { noteOutcome(usageFile(space), judge.id, failure); } catch (error) { console.warn("[polyth] judges: usage ledger not updated", error); }
  };

  /**
   * Records what a fired judge decided and runs its actions. Every action but
   * the message runs first and is recorded with its outcome; the message is
   * recorded as sending and goes last, so the note sits above it in the chat.
   * Returns each action's outcome, in run order.
   */
  const fire = async (judge: JudgeDefinition, outcome: Pick<CustomOutcome, "fires" | "actions" | "label" | "probability" | "probabilities" | "margin">,
    sessionId: string, access: OwnerAccess, target: Omit<ActionTarget, "sessionId" | "sessions" | "ownerUserId" | "events">, live: () => boolean,
  ): Promise<AssessmentAction[]> => {
    const acting: ActionTarget | undefined = access.sessions && judge.ownerUserId ? {
      ...target, sessionId, sessions: access.sessions, ownerUserId: judge.ownerUserId,
      events: async () => host.store.events(sessionId),
      isolation: host.services.get(SERVER_SESSION_ISOLATION), maxRounds: judge.maxRounds,
    } : undefined;
    const results: AssessmentAction[] = [];
    let message: Extract<JudgeDefinition["effects"][number], { kind: "send-message" }> | undefined;
    for (const effect of outcome.actions) {
      if (!live()) { results.push({ kind: effect.kind, status: "skipped", detail: "Judges was turned off" }); continue; }
      if (!acting) { results.push({ kind: effect.kind, status: "skipped", detail: ACTS_FOR_NO_ONE }); continue; }
      if (effect.kind === "send-message") {
        const blocked = await sendBlocked(acting).catch((error: unknown) => error instanceof Error ? error.message : String(error));
        if (blocked) results.push({ kind: effect.kind, status: "skipped", detail: blocked });
        else { message = effect; results.push({ kind: effect.kind, status: "sending", detail: effect.text }); }
        continue;
      }
      results.push(await runAction(effect, acting));
    }
    if (!outcome.fires && !results.length) return results;
    // Something that already happened is always recorded; otherwise a disabled package records nothing.
    if (!live() && !results.some((result) => result.status === "done" || result.status === "sending")) return results;
    await record(sessionId, assessmentFor(judge, outcome as CustomOutcome, Date.now(), results));
    if (!message || !acting) return results;
    try { await sendMessage(message, acting); }
    catch (error) {
      // Never retried: an uncertain send may have landed.
      await record(sessionId, assessmentFor(judge, { ...outcome, fires: false } as CustomOutcome, Date.now(),
        [{ kind: "send-message", status: "failed", detail: error instanceof Error ? error.message : String(error) }]));
    }
    return results;
  };

  /** One completed turn of an eligible session: built-ins, then every matching custom judge. */
  const evaluateTurn = async (sessionId: string, admitted: number) => {
    const service = judgment();
    if (!service || admitted !== generation) return;
    const projection = await host.store.projection(sessionId);
    if (!eligible(projection)) return;
    const space = host.systemSpaceContext(projection.spaceId!);
    const events = await host.store.events(sessionId);
    const lastUser = events.findLast((event) => event.type === "user/message" && !event.ignorable);
    // Our own keep-alive finished: it is not work, so nothing is judged and the chat stays armed.
    if (isKeepAlive(lastUser)) { keepWarm.settlePing(sessionId); return; }
    // Any other turn ends the pause the chat was armed for; it may re-arm below.
    keepWarm.disarm(sessionId);
    const turn = latestTurnEvidence(events);
    if (!turn || alreadyJudged(events, turn.turnSeq) || seen.has(`turn:${sessionId}:${turn.turnSeq}`)) return;
    remember(`turn:${sessionId}:${turn.turnSeq}`);
    const ctx = { judgment: service, space, projectId: projection.projectId, sessionId, signal: lifetime.signal };
    const live = () => enabled && admitted === generation;
    for (const run of [runCompletionCheck, runNeedsYou]) {
      try {
        const assessment = await run(ctx, turn);
        if (assessment && live()) await record(sessionId, assessment);
      } catch (error) { console.warn("[polyth] judges: built-in judge failed", error); }
    }
    try {
      const params = await keepWarmParams(ctx);
      // Scheduled agents keep their own cache warm; small or unknown caches are not worth a Judgment call.
      const scheduled = (lastUser?.data as { author?: { via?: unknown } } | undefined)?.author?.via === "schedule";
      const facts = params && !scheduled ? sessionCacheFacts(projection, events) : null;
      if (params && !scheduled && !cacheIneligible(facts, params.minCachedTokens)) {
        const verdict = await judgeContinuation(ctx, turn, params);
        if (verdict && live()) keepWarm.arm({ sessionId, spaceId: projection.spaceId, turnSeq: turn.turnSeq, probability: verdict.probability,
          budget: keepAliveBudget(verdict.probability, verdict.params.maxKeepAlives),
          minCachedTokens: verdict.params.minCachedTokens, dailyLimit: verdict.params.dailyLimit });
      }
    } catch (error) { console.warn("[polyth] judges: keep-warm check failed", error); }
    for (const judge of judgesOf(space, "turn-completed", projection.projectId)) {
      if (!live()) return;
      try {
        const access = await ownerAccess(judge, projection.spaceId, sessionId);
        if (!access || !reserveCall(usageFile(space), judge.id, judge.dailyCap)) continue;
        // An owned judge asks as its owner, so their Small Model answers.
        const outcome = await askJudge({ ...ctx, space: access.space ?? space }, judge, turn);
        noteCall(space, judge, outcome.failure);
        if (outcome.wouldFire && live()) await fire(judge, outcome, sessionId, access, { turnSeq: turn.turnSeq }, live);
      } catch (error) { console.warn("[polyth] judges: custom judge failed", error); }
    }
  };

  /** A permission request waiting for a person: permission judges may answer it or change Auto-Approve. */
  const evaluatePermission = async (sessionId: string, requestId: string, automaticAllowed: boolean, admitted: number) => {
    const service = judgment();
    if (!service || admitted !== generation) return;
    const projection = await host.store.projection(sessionId);
    if (!eligibleForRequests(projection)) return;
    const space = host.systemSpaceContext(projection.spaceId);
    const judges = judgesOf(space, "permission-requested", projection.projectId);
    if (!judges.length) return;
    const ctx = { judgment: service, space, projectId: projection.projectId, sessionId, signal: lifetime.signal };
    const live = () => enabled && admitted === generation;
    for (const judge of judges) {
      if (!live()) return;
      // A judge that approves or denies tells the request's card it is checking, then where its answer leaves the request.
      const decides = decidesRequests(judge);
      const check = (state: RequestCheckData["state"], reason?: string) => recordForCard(projection, judge, REQUEST_CHECK_EVENT,
        { judgeId: judge.id, title: judge.name, requestId, state, ...(reason ? { reason } : {}), ts: Date.now() });
      let checking = false, unanswered = "failed";
      try {
        // Re-read per judge: once one judge (or the person) answered, the rest have nothing to decide.
        const events = await host.store.events(sessionId);
        const request = permissionEvidence(events, requestId);
        if (!request?.open) return;
        const access = await ownerAccess(judge, projection.spaceId, sessionId);
        if (!access || !reserveCall(usageFile(space), judge.id, judge.dailyCap)) continue;
        const turn = currentTurnEvidence(events) ?? emptyTurn(events);
        if (decides) { checking = true; await check("checking"); }
        const outcome = await askJudge({ ...ctx, space: access.space ?? space }, judge, turn, request);
        noteCall(space, judge, outcome.failure);
        unanswered = outcome.failure ?? "no-answer";
        if (!live()) { unanswered = "cancelled"; return; }
        const results = outcome.wouldFire ? await fire(judge, outcome, sessionId, access, { requestId, automaticAllowed }, live) : [];
        // Fired or not, a deciding judge tells the request's card where its answer leaves it.
        const verdict = requestVerdict(judge, outcome);
        if (verdict && live()) {
          await recordForCard(projection, judge, REQUEST_VERDICT_EVENT, { judgeId: judge.id, title: judge.name, requestId, ...verdict,
            ...actionNote(verdict.verdict, results), ts: Date.now() } satisfies RequestVerdictData);
          // The verdict is on the card now and ends the check by itself.
          checking = false;
        } else if (verdict) unanswered = "cancelled";
      } catch (error) {
        unanswered = "failed";
        console.warn("[polyth] judges: permission judge failed", error);
      } finally {
        // However the call ended, the card must not keep saying the judge is checking. The check
        // already happened, so it is closed even after the package was turned off (as `fire`
        // records actions that ran): this request is not judged again.
        if (checking) await check("no-answer", unanswered).catch((error: unknown) => console.warn("[polyth] judges: check not closed", error));
      }
    }
  };

  /** A turn stopped on a usage limit with an automatic resume pending: limit judges may continue it on another model. */
  const evaluateLimit = async (sessionId: string, admitted: number) => {
    const service = judgment();
    if (!service || admitted !== generation) return;
    const projection = await host.store.projection(sessionId);
    if (!eligibleForRequests(projection) || !projection.resume) return;
    const resume = projection.resume;
    const key = `limit:${sessionId}:${resume.userMessageSeq}:${resume.attempt}`;
    if (seen.has(key)) return;
    remember(key);
    const space = host.systemSpaceContext(projection.spaceId);
    const judges = judgesOf(space, "limit-reached", projection.projectId);
    if (!judges.length) return;
    const live = () => enabled && admitted === generation;
    const events = await host.store.events(sessionId);
    const turn = currentTurnEvidence(events);
    const current = currentRoute(projection);
    for (const judge of judges) {
      if (!live()) return;
      try {
        const access = await ownerAccess(judge, projection.spaceId, sessionId);
        if (!access?.sessions || !access.space) continue;
        // The owner's own shortlist names the models and their headroom; Usage off leaves headroom unknown.
        const report = await host.services.get(SERVER_MODEL_ROUTING)?.candidates(access.space, { pairs: judge.routes ?? [], limit: 50 })
          .catch((error: unknown) => { console.warn("[polyth] judges: model headroom unavailable", error); return undefined; });
        const options = routeOptions(judge, report, current);
        // Nothing allowed is usable now: waiting is the only answer, so nothing is asked.
        if (!options.length || !reserveCall(usageFile(space), judge.id, judge.dailyCap)) continue;
        const ask = routeAsk(judge, options, { resume, current, report, turn, now: Date.now() });
        const run = await service.createRun({ space: access.space, projectId: projection.projectId });
        let result: JudgmentResult<{ route: JudgmentQuestion }>;
        try {
          result = await run.judge({ scope: customScope(judge.id), state: ask.state, signal: lifetime.signal, target: judgeTarget(judge),
            questions: { route: ask.question }, metadata: { sessionId } }) as JudgmentResult<{ route: JudgmentQuestion }>;
        } finally { run.dispose(); }
        noteCall(space, judge, result.ok ? undefined : result.reason);
        const decision = routeDecision(judge, options, result);
        if (!decision.option || !live()) continue;
        const outcome = { fires: true, actions: [{ kind: "switch-route" as const }], label: decision.option.name,
          probability: decision.probability ?? 0, ...(decision.probabilities ? { probabilities: decision.probabilities } : {}),
          ...(decision.margin !== undefined ? { margin: decision.margin } : {}) };
        await fire(judge, outcome, sessionId, access, { route: decision.option }, live);
        // One switch per stop: the chat is moving on.
        if (!(await host.store.projection(sessionId))?.resume) return;
      } catch (error) { console.warn("[polyth] judges: limit judge failed", error); }
    }
  };

  const keepWarm = createKeepWarm({
    now: () => Date.now(),
    async facts(sessionId) {
      const projection = await host.store.projection(sessionId);
      return projection ? sessionCacheFacts(projection, await host.store.events(sessionId)) : null;
    },
    async ready(entry) {
      const projection = await host.store.projection(entry.sessionId);
      if (!enabled || !eligible(projection) || projection.status !== "idle") return false;
      // The person spoke since the arming turn (even if that turn failed): its pause is over.
      const lastRequest = (await host.store.events(entry.sessionId))
        .findLast((event) => event.type === "user/message" && !event.ignorable && !isKeepAlive(event));
      if (lastRequest && lastRequest.seq > entry.turnSeq) { keepWarm.disarm(entry.sessionId); return false; }
      const sessions = await systemSessionsForSession(host, entry.sessionId);
      return ((await sessions.queueList?.(entry.sessionId)) ?? []).length === 0;
    },
    async send(sessionId) {
      const sessions = await systemSessionsForSession(host, sessionId);
      await sessions.send(sessionId, { text: KEEP_ALIVE_PROMPT, hiddenUserMessage: true, memory: { read: "off", remember: "off" } });
    },
    onError: (error) => console.warn("[polyth] judges: keep-alive not sent", error),
  });
  let keepWarmTimer: ReturnType<typeof setInterval> | undefined;

  const seen = new Set<string>();
  const remember = (key: string) => {
    seen.add(key);
    if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!);
  };
  // A bounded background queue: the host awaits bus listeners in order, so listeners only enqueue.
  const queued = new Map<string, () => Promise<void>>();
  let active = 0;
  const pump = () => {
    while (active < MAX_ACTIVE && queued.size) {
      const [key, job] = queued.entries().next().value as [string, () => Promise<void>];
      queued.delete(key);
      active++;
      void job()
        .catch((error: unknown) => console.warn("[polyth] judges: evaluation failed", error))
        .finally(() => { active--; pump(); });
    }
  };
  const enqueue = (key: string, job: () => Promise<void>) => {
    if (!enabled) return;
    queued.delete(key);
    queued.set(key, job);
    pump();
  };

  const validateProject = async (space: SpaceContext, projectId: string) => {
    if (!projectId || !await host.forSpace(space).projects.get(projectId)) throw Object.assign(new Error("Project not found"), { code: "not-found" });
  };
  const snapshot = (space: SpaceContext): JudgesSnapshot => {
    const stored = readJudges(judgesFile(space));
    return { revision: stored.revision, judges: stored.judges, usage: usageToday(usageFile(space)), judgmentAvailable: !!judgment(),
      ...(isPerson(space) ? { viewer: space.userId } : {}) };
  };
  const bodyOf = async (rc: Parameters<NonNullable<ServerPackage["routes"]>>[0]) => {
    const body = await rc.body();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("Invalid request"), { code: "invalid-input" });
    return body as Record<string, unknown>;
  };
  /** A project filter must name a project of this Space; actions need a person to act for. */
  const checkJudge = async (space: SpaceContext, judge: unknown) => {
    const projectId = (judge as { filters?: { projectId?: unknown } } | undefined)?.filters?.projectId;
    if (typeof projectId === "string") await validateProject(space, projectId);
    if (hasActions(validateJudgeInput(judge)) && !isPerson(space)) {
      throw forbidden("Actions need a signed-in person: a judge acts with the access of the person who saves it");
    }
  };
  const owner = (space: SpaceContext) => (isPerson(space) ? space.userId : undefined);

  const routes = async (space: SpaceContext): Promise<JudgeRoutesSnapshot> => {
    const routing = host.services.get(SERVER_MODEL_ROUTING);
    if (!routing) return { routes: [], catalogUnavailable: true };
    const report = await routing.candidates(space, { limit: 50 });
    return {
      routes: report.candidates.map((candidate) => ({ key: routeKey(candidate), harnessId: candidate.harnessId, providerID: candidate.providerID,
        modelID: candidate.modelID, ...(candidate.runs ? { runs: candidate.runs } : {}), favorite: candidate.favorite, available: candidate.available,
        ...(candidate.quotaUsed !== undefined ? { quotaUsed: candidate.quotaUsed } : {}), blocked: candidate.blocked,
        ...(candidate.blockedUntil !== undefined ? { blockedUntil: candidate.blockedUntil } : {}) })),
      ...(report.catalogUnavailable ? { catalogUnavailable: true } : {}),
    };
  };

  const backtest = async (space: SpaceContext, projectId: string, judge: JudgeDefinition, limit: number): Promise<BacktestRow[]> => {
    const service = judgment();
    if (!service) throw Object.assign(new Error("Judgment is not running"), { code: "unavailable" });
    if (judge.trigger !== "turn-completed") throw Object.assign(new Error("Backtest replays finished turns: it covers judges that run after a turn"), { code: "invalid-input" });
    const sessions = (await host.forSpace(space).sessions.list(projectId))
      .filter((session) => session.projectId === projectId && eligible({ ...session, spaceId: session.spaceId ?? space.spaceId }))
      .sort((a, b) => (b.lastTurnAt ?? b.updatedAt) - (a.lastTurnAt ?? a.updatedAt));
    let candidates: Array<{ session: SessionProjection; turn: NonNullable<ReturnType<typeof latestTurnEvidence>>; time: number }> = [];
    for (const session of sessions) {
      // Sessions are newest first: once `limit` turns are newer than this session's last turn, none of its turns can qualify.
      if (candidates.length >= limit && candidates[limit - 1]!.time > (session.lastTurnAt ?? session.updatedAt)) break;
      // An owned judge reads only chats its owner can open, whoever runs the backtest.
      if (!await ownerAccess(judge, session.spaceId ?? space.spaceId, session.id)) continue;
      const events: SessionEvent[] = await host.store.events(session.id);
      const time = (seq: number) => events.find((event) => event.seq === seq)?.time ?? 0;
      for (const turn of completedTurns(events, limit)) candidates.push({ session, turn, time: time(turn.turnSeq) });
      candidates = candidates.sort((a, b) => b.time - a.time).slice(0, limit);
    }
    const newest = candidates;
    const rows: BacktestRow[] = [];
    for (const { session, turn } of newest) {
      const row = { sessionId: session.id, title: session.title, turnSeq: turn.turnSeq };
      // Backtests count toward the same daily cap as live runs, and record nothing.
      if (!reserveCall(usageFile(space), judge.id, judge.dailyCap)) { rows.push({ ...row, wouldFire: false, skipped: "cap" }); continue; }
      const outcome = await askJudge({ judgment: service, space, projectId, sessionId: session.id, signal: lifetime.signal }, judge, turn);
      noteCall(space, judge, outcome.failure);
      rows.push({ ...row, wouldFire: outcome.wouldFire,
        ...(outcome.actions.length ? { wouldDo: outcome.actions.map((action) => action.kind) } : {}),
        ...(outcome.label !== undefined ? { label: outcome.label } : {}),
        ...(outcome.probability !== undefined ? { probability: outcome.probability } : {}),
        ...(outcome.failure ? { skipped: outcome.failure } : {}) });
    }
    return rows;
  };

  return {
    remoteAccess: localOnlyRemoteAccess(["judges"]),
    async routes(rc) {
      if (rc.path !== "/api/judges" && !rc.path.startsWith("/api/judges/")) return false;
      const space = rc.space, projectId = rc.url.searchParams.get("projectId") ?? "";
      await validateProject(space, projectId);
      if (rc.path === "/api/judges" && rc.method === "GET") { rc.json(200, snapshot(space)); return true; }
      if (rc.path === "/api/judges" && rc.method === "POST") {
        const body = await bodyOf(rc);
        await checkJudge(space, body.judge);
        createJudge(judgesFile(space), body.revision, body.judge, Date.now(), owner(space));
        rc.json(200, snapshot(space)); return true;
      }
      if (rc.path === "/api/judges/routes" && rc.method === "GET") { rc.json(200, await routes(space)); return true; }
      const match = rc.path.match(/^\/api\/judges\/([^/]+)(\/backtest)?$/);
      const id = match?.[1] ?? "";
      if (!match || !JUDGE_ID.test(id)) return false;
      if (match[2] && rc.method === "POST") {
        const body = await bodyOf(rc);
        const limit = body.limit ?? 10;
        if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_BACKTEST) {
          throw Object.assign(new Error(`Backtest 1–${MAX_BACKTEST} turns`), { code: "invalid-input" });
        }
        const judge = readJudges(judgesFile(space)).judges.find((entry) => entry.id === id);
        if (!judge) throw Object.assign(new Error("Judge not found"), { code: "not-found" });
        const rows = await backtest(space, projectId, judge, limit as number);
        rc.json(200, { judgeId: id, rows, usage: usageToday(usageFile(space))[id] ?? { day: new Date().toISOString().slice(0, 10), count: 0 } });
        return true;
      }
      if (match[2]) return false;
      if (rc.method === "PUT") {
        const body = await bodyOf(rc);
        await checkJudge(space, body.judge);
        updateJudge(judgesFile(space), body.revision, id, body.judge, Date.now(), owner(space));
        rc.json(200, snapshot(space)); return true;
      }
      if (rc.method === "DELETE") {
        const revision = rc.url.searchParams.get("revision");
        deleteJudge(judgesFile(space), revision === null ? Number.NaN : Number(revision), id);
        rc.json(200, snapshot(space)); return true;
      }
      return false;
    },
    onEnable() {
      enabled = true;
      generation++;
      lifetime = new AbortController();
      judgment();
      subscriptions.forEach((subscription) => subscription.dispose());
      const admitted = generation;
      subscriptions = [
        host.services.get(SERVER_TURN_COMPLETION_BUS)?.subscribe(({ sessionId }) => {
          enqueue(`turn:${sessionId}`, () => evaluateTurn(sessionId, admitted));
        }),
        host.services.get(SERVER_PERMISSION_WAITING_BUS)?.subscribe(({ sessionId, requestId, automaticAllowed }) => {
          const key = `permission:${sessionId}:${requestId}`;
          if (seen.has(key)) return;
          remember(key);
          enqueue(key, () => evaluatePermission(sessionId, requestId, automaticAllowed, admitted));
        }),
        host.services.get(SERVER_TURN_STOPPED_BUS)?.subscribe(({ sessionId, reason }) => {
          if (reason === "error") enqueue(`limit:${sessionId}`, () => evaluateLimit(sessionId, admitted));
        }),
      ].filter((subscription): subscription is { dispose(): void } => !!subscription);
      keepWarmTimer ??= setInterval(() => { void keepWarm.tick(); }, KEEP_WARM_TICK_MS);
      keepWarmTimer.unref?.();
    },
    onDisable() {
      enabled = false;
      generation++;
      subscriptions.forEach((subscription) => subscription.dispose()); subscriptions = [];
      queued.clear();
      lifetime.abort();
      if (keepWarmTimer) clearInterval(keepWarmTimer);
      keepWarmTimer = undefined;
      keepWarm.clear();
      registered?.off.forEach((off) => off()); registered = undefined;
    },
  };
}

/** Ordinary top-level chats only: no delegated children, archived sessions or pending history imports. */
function eligible(projection: SessionProjection | undefined): projection is SessionProjection & { spaceId: string } {
  return eligibleForRequests(projection) && !projection.parentId;
}

/** Requests and usage limits also reach delegated children, whose cards mirror into their parent. */
function eligibleForRequests(projection: SessionProjection | undefined): projection is SessionProjection & { spaceId: string } {
  return !!projection && !!projection.spaceId && projection.status !== "archived"
    && (!projection.historyImport || projection.historyImport.state === "complete");
}

/** An approving or denying verdict whose action did not go through says why, so its card does not read as answered. */
function actionNote(verdict: RequestVerdictKind, results: readonly AssessmentAction[]): Pick<RequestVerdictData, "action"> {
  const action = verdict === "approve"
    ? results.find((result) => result.kind === "approve-request") ?? results.find((result) => result.kind === "set-approval")
    : verdict === "deny" ? results.find((result) => result.kind === "deny-request") : undefined;
  if (!action || (action.status !== "skipped" && action.status !== "failed")) return {};
  const kind = action.kind as NonNullable<RequestVerdictData["action"]>["kind"];
  const reason = action.detail === SPACE_NEVER_APPROVES ? "space-never-approves" : action.detail === ACTS_FOR_NO_ONE ? "acts-for-no-one" : undefined;
  return { action: { kind, status: action.status, ...(action.detail ? { detail: action.detail } : {}), ...(reason ? { reason } : {}) } };
}

/** A request that arrives before any assistant output still has the person's request as evidence. */
function emptyTurn(events: readonly SessionEvent[]): TurnEvidence {
  return { turnSeq: events.at(-1)?.seq ?? 0, request: "", answer: "", commands: [], changedFiles: [], openTodos: [] };
}

/** A turn is judged once, even if the completion bus repeats. */
function alreadyJudged(events: readonly SessionEvent[], turnSeq: number): boolean {
  return events.some((event) => event.seq > turnSeq && event.type === ASSESSMENT_EVENT);
}
