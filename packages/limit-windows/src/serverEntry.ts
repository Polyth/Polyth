import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  allowedHarnessesFor,
  hasHarnessManagerAuthority,
  type InstanceAuthorityRequest,
} from "@polyth/contracts/instance-authority";
import {
  allowsInteractiveProviderAuth,
  harnessUsableByUser,
  type HarnessProvider,
  type HarnessRegistry,
  type RouteHandler,
} from "@polyth/contracts";
import {
  localOnlyRemoteAccess,
  packageDataDir,
  SERVER_RUNTIME_CATALOG,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import { canonicalModelSource, canonicalSource } from "@polyth/usage/limit-sources";
import { createWindowController, modelFor, PING_TIMEOUT_MS, type PingTarget, type WindowController } from "./controller.ts";
import { decide, type Decision } from "./decide.ts";
import type { CatalogModel } from "./models.ts";
import { defaultPlan, parsePlan, projectWindows, type WindowPlan } from "./plan.ts";
import { isValidTimeZone } from "./schedule.ts";
import { createPlanStore, type PlanStore } from "./store.ts";
import type { LimitWindowsState, MeterView, ModelOption, SourceView } from "./types.ts";
import { metersOf, phaseOf, type LimitSource } from "./windows.ts";

const PACKAGE_ID = "limit-windows";
/** One line in, one word out: the request only has to reach the model. */
const START_PROMPT = "Reply with just: OK";
const MAX_OUTPUT_TOKENS = 16;
/** The strip on the settings page; 26 h so tomorrow's same hour is in view. */
const FORECAST_MS = 26 * 60 * 60_000;
const HISTORY_IN_VIEW = 12;
/** What a refusal tells the client: nothing happened, and retrying won't change it. */
const NOT_STARTED = { mutationOutcome: "not-started", retryability: "never" } as const;
const CATALOG_MAX_AGE_MS = 10 * 60_000;

/** The Limits service as this package reads it. */
interface LimitsService {
  snapshots(): LimitSource[];
  refresh(providerId: string): Promise<LimitSource>;
}
const LIMITS_SERVICE = serverServiceKey<LimitsService>("usage-limits");
const HARNESSES_SERVICE = serverServiceKey<HarnessRegistry>("harnesses");

const titleCase = (value: string): string =>
  value.split(/[-_]/).filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");

const SOURCE_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  "opencode-go": "OpenCode Go",
  "opencode-zen": "OpenCode Zen",
};

/** The harness a source's requests run on: the account's own, the harness that
 *  shares the source's id, else one whose catalog lists the source's provider
 *  (OpenCode first). Reaching a login another way would meter another account. */
export function routeOfSource(
  source: LimitSource,
  models: readonly CatalogModel[],
  registered: (harnessId: string) => boolean,
): { harnessId: string; models: CatalogModel[] } | undefined {
  const own = source.account?.harnessId ?? source.providerId;
  if (registered(own)) return { harnessId: own, models: models.filter((row) => row.harnessId === own) };
  if (source.account) return undefined;
  const wanted = canonicalSource(source.providerId);
  const rows = models.filter((row) => row.harnessId && registered(row.harnessId) && canonicalModelSource(row.providerID) === wanted);
  const harnessIds = [...new Set(rows.map((row) => row.harnessId!))].sort((a, b) => Number(b === "opencode") - Number(a === "opencode"));
  const harnessId = harnessIds[0];
  return harnessId ? { harnessId, models: rows.filter((row) => row.harnessId === harnessId) } : undefined;
}

const optionOf = (row: CatalogModel): ModelOption => ({ providerID: row.providerID, modelID: row.modelID, name: row.name || row.modelID });

/** Every plan names one source; only an existing account's name is public. */
const sourceTitle = (source: LimitSource, provider: HarnessProvider | undefined): string => {
  const base = SOURCE_NAMES[source.account?.family ?? source.providerId] ?? titleCase(source.account?.family ?? source.providerId);
  return source.account ? `${base} · ${provider?.descriptor.accountLabel?.trim() || source.account.label}` : base;
};

interface Access {
  access: "edit" | "view" | "none";
  provider?: HarnessProvider;
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const dataDir = packageDataDir(host);
  const available = allowsInteractiveProviderAuth(host.deployment);
  const store: PlanStore = createPlanStore(dataDir);
  // An empty directory: no project instructions, repository or history reach the
  // CLI, so a request costs only what the harness itself always sends.
  const startDir = join(dataDir, "start");

  const harnesses = () => host.services.get(HARNESSES_SERVICE);
  const limits = () => host.services.get(LIMITS_SERVICE);
  const providerOf = (source: LimitSource): HarnessProvider | undefined =>
    harnesses()?.get(source.account?.harnessId ?? source.providerId);
  const catalog = async (options?: { maxAgeMs: number }): Promise<readonly CatalogModel[]> =>
    await host.services.get(SERVER_RUNTIME_CATALOG)?.models(options) ?? [];
  const routeOf = (source: LimitSource, models: readonly CatalogModel[]) =>
    routeOfSource(source, models, (id) => Boolean(harnesses()?.get(id)));

  const send = async ({ harnessId, model }: PingTarget, spaceId: string, signal: AbortSignal): Promise<void> => {
    const provider = harnesses()?.get(harnessId);
    if (!provider) throw Object.assign(new Error("the harness is no longer registered"), { code: "unavailable" });
    if (provider.completeUtility) {
      mkdirSync(startDir, { recursive: true });
      await provider.completeUtility({ cwd: startDir, prompt: START_PROMPT, model, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: PING_TIMEOUT_MS, signal });
      return;
    }
    // A harness that serves a whole workspace answers in a project of the Space
    // the plan was saved from, on its runtime for that project.
    const projects = await host.forSpace(host.systemSpaceContext(spaceId)).projects.list();
    const project = projects.find((row) => !row.remote);
    if (!project) throw Object.assign(new Error("this harness needs a local project to run in"), { code: "unavailable" });
    const runtime = await host.runtimes.forProject(project.id, project.path, harnessId);
    await host.smallModelComplete(runtime, {
      cwd: project.path,
      prompt: START_PROMPT,
      model,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: PING_TIMEOUT_MS,
      signal,
      purpose: "minimal",
    });
  };

  const controller: WindowController = createWindowController({
    now: () => Date.now(),
    sources: () => limits()?.snapshots() ?? [],
    async refresh(sourceId) {
      const service = limits();
      if (!service) throw Object.assign(new Error("Usage is not available"), { code: "unavailable" });
      return service.refresh(sourceId);
    },
    routeOf,
    // A request names a model the harness offers today, not at the last restart.
    models: () => catalog({ maxAgeMs: CATALOG_MAX_AGE_MS }),
    authorized(sourceId) {
      const stored = store.plan(sourceId);
      const source = limits()?.snapshots().find((row) => row.providerId === sourceId);
      if (!stored || !source) return false;
      // A login that changed hands, however the id came back, is not this plan's.
      return (providerOf(source)?.descriptor.accountOwnerUserId ?? undefined) === stored.ownerUserId;
    },
    send,
    store,
    onError: (context, error) => console.warn(`[limit-windows] ${context} failed`, error instanceof Error ? error.message : error),
  });

  const accessOf = (request: InstanceAuthorityRequest, source: LimitSource): Access => {
    const provider = providerOf(source);
    const userId = request.space.userId;
    const owner = provider?.descriptor.accountOwnerUserId;
    // A private login spends one person's quota, so only that person sees it. Its
    // schedule is theirs alone; not even the instance owner sets it for them.
    if (owner) return owner === userId ? { access: "edit", provider } : { access: "none" };
    if (hasHarnessManagerAuthority(request)) return { access: "edit", ...(provider ? { provider } : {}) };
    if (provider && harnessUsableByUser(provider.descriptor, userId, allowedHarnessesFor(request), request.space.spaceId)) {
      return { access: "view", provider };
    }
    return { access: "none" };
  };

  const meterViews = (source: LimitSource, plan: WindowPlan, savedAt: number, models: readonly CatalogModel[]): MeterView[] => {
    const now = Date.now();
    const route = routeOf(source, models);
    return metersOf(source).map((meter) => {
      const records = store.records(source.providerId, meter.id);
      const decision: Decision = decide({ plan, savedAt, meter, source, records, now });
      const chosen = route ? modelFor(plan, source, meter, route.models) : undefined;
      const primary = meter.primary;
      const phase = phaseOf(primary, source.fetchedAt, now);
      const period = primary.periodMs ?? 0;
      // A request whose effect is not read yet counts as the window it should start.
      const checking = decision.kind === "verify" ? decision.record : undefined;
      const runningTo = checking ? checking.at + checking.periodMs : phase === "running" ? primary.resetsAt : undefined;
      const waiting = decision.kind === "wait" ? decision : undefined;
      const planned = plan.mode === "off" || plan.skipMeters?.includes(meter.id)
        ? []
        : projectWindows(plan, period, waiting?.hold === "exhausted" ? Math.max(runningTo ?? 0, waiting.at) : runningTo ?? 0, now, now + FORECAST_MS, savedAt);
      const start = decision.kind === "ping" || decision.kind === "wait" ? decision.start : undefined;
      const view: MeterView = {
        id: meter.id,
        ...(meter.label ? { label: meter.label } : {}),
        windows: meter.windows.map((window) => ({
          id: window.id,
          label: window.label,
          phase: phaseOf(window, source.fetchedAt, now),
          used: window.limit > 0 ? Math.min(1, window.used / window.limit) : 0,
          ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
          ...(window.periodMs !== undefined ? { periodMs: window.periodMs } : {}),
        })),
        primaryId: primary.id,
        ...(runningTo !== undefined ? { running: { from: runningTo - period, to: runningTo } } : {}),
        planned,
        ...(start ? { next: { at: start.at, reason: start.reason, ...(start.targetAt !== undefined ? { targetAt: start.targetAt } : {}) } } : {}),
        ...(waiting?.hold ? { hold: waiting.hold, ...(Number.isFinite(waiting.at) ? { holdUntil: waiting.at } : {}) } : {}),
        ...(chosen?.model ? { model: optionOf(chosen.model) } : {}),
        ...(chosen?.replaced ? { modelReplaced: true } : {}),
        options: (chosen?.options ?? []).map(optionOf),
        ...(!route ? { problem: "no-route" as const } : !chosen?.model ? { problem: "no-model" as const } : {}),
        history: records.slice(0, HISTORY_IN_VIEW),
        busy: controller.busy(source.providerId, meter.id),
        ...(checking ? { checking: true } : {}),
      };
      return view;
    });
  };

  const sourceView = (source: LimitSource, access: Access, models: readonly CatalogModel[], timeZone: string): SourceView => {
    const stored = store.plan(source.providerId);
    const plan = stored?.plan ?? defaultPlan(timeZone);
    const route = routeOf(source, models);
    return {
      id: source.providerId,
      title: sourceTitle(source, access.provider),
      ...(route ? { harnessId: route.harnessId } : {}),
      private: Boolean(access.provider?.descriptor.accountOwnerUserId),
      access: access.access === "edit" ? "edit" : "view",
      plan,
      saved: Boolean(stored),
      fetchedAt: source.fetchedAt,
      stale: source.stale,
      ...(source.error ? { error: source.error.code } : {}),
      meters: meterViews(source, plan, stored?.updatedAt ?? 0, models),
    };
  };

  const routes: RouteHandler = async (request) => {
    const { path, method, json, body, url } = request;
    if (path !== "/api/limit-windows/state" && !path.startsWith("/api/limit-windows/plans/")) return false;
    const service = limits();
    if (!available || !service) {
      if (method === "GET") {
        json(200, { available: false, now: Date.now(), sources: [] } satisfies LimitWindowsState);
        return true;
      }
      json(403, { error: "unavailable", message: "Limit windows need a trusted local deployment with Usage enabled", ...NOT_STARTED });
      return true;
    }

    const steerable = () => service.snapshots().filter((source) => metersOf(source).length > 0);
    const sourceFor = (id: string): LimitSource | undefined => steerable().find((row) => row.providerId === id);

    if (path === "/api/limit-windows/state" && method === "GET") {
      const zone = url.searchParams.get("timeZone");
      const timeZone = isValidTimeZone(zone) ? zone : "UTC";
      const models = await catalog().catch(() => [] as readonly CatalogModel[]);
      const sources = steerable().flatMap((source) => {
        const access = accessOf(request, source);
        return access.access === "none" ? [] : [sourceView(source, access, models, timeZone)];
      });
      json(200, { available: true, now: Date.now(), sources } satisfies LimitWindowsState);
      return true;
    }

    const match = path.match(/^\/api\/limit-windows\/plans\/([^/]+)(\/start)?$/);
    if (!match) return false;
    let sourceId: string;
    try {
      sourceId = decodeURIComponent(match[1]!);
    } catch {
      json(400, { error: "invalid-input", message: "malformed account id" });
      return true;
    }
    const source = sourceFor(sourceId);
    const access = source ? accessOf(request, source) : { access: "none" as const };
    if (!source || access.access === "none") {
      json(404, { error: "not-found", message: "account not found", ...NOT_STARTED });
      return true;
    }
    if (access.access !== "edit") {
      json(403, { error: "forbidden", message: "only a harness manager can change this account's windows", ...NOT_STARTED });
      return true;
    }

    if (!match[2] && method === "PUT") {
      let plan: WindowPlan;
      try {
        plan = parsePlan(await body());
      } catch (error) {
        json(400, { error: "invalid-input", message: error instanceof Error ? error.message : "invalid plan", ...NOT_STARTED });
        return true;
      }
      const owner = access.provider?.descriptor.accountOwnerUserId;
      store.savePlan(sourceId, {
        plan,
        spaceId: request.space.spaceId,
        updatedBy: request.space.userId,
        updatedAt: Date.now(),
        ...(owner ? { ownerUserId: owner } : {}),
      });
      controller.touch(sourceId);
      const models = await catalog().catch(() => [] as readonly CatalogModel[]);
      json(200, sourceView(source, access, models, plan.timeZone));
      return true;
    }

    if (match[2] && method === "POST") {
      const input = await body().catch(() => ({} as Record<string, unknown>));
      const meterId = typeof input.meterId === "string" ? input.meterId : "";
      try {
        const result = await controller.startNow(sourceId, meterId, request.space.spaceId);
        if ("problem" in result) {
          json(result.problem === "not-found" ? 404 : 409, { error: result.problem, message: "the window cannot be started now", ...NOT_STARTED });
          return true;
        }
        json(200, { record: result });
      } catch (error) {
        console.warn("[limit-windows] manual start failed", error instanceof Error ? error.message : error);
        // A failed send is a recorded result; this is a read or a store that failed
        // before or around it, so whether a request left is not known here.
        json(503, { error: "unavailable", message: "the window could not be read or started", mutationOutcome: "unknown", retryability: "never" });
      }
      return true;
    }
    return false;
  };

  return {
    remoteAccess: localOnlyRemoteAccess([PACKAGE_ID]),
    routes,
    onEnable() {
      if (available) controller.start();
    },
    onDisable() {
      controller.stop();
    },
  };
}
