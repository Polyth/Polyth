import type { RouteHandler, SpaceContext } from "@polyth/contracts";
import {
  SERVER_DELEGATION_POLICY,
  SERVER_MODEL_FAVORITES,
  SERVER_MODEL_ROUTING,
  SERVER_RUNTIME_CATALOG,
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerModelRoutingOptions,
  type ServerModelRoutingOrder,
  type ServerModelRoutingReport,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  AGENT_SHORTLIST_ROWS,
  ORCHESTRATION_API,
  ORCHESTRATION_PACKAGE_ID,
  type OrchestrationState,
  type RoutingPolicy,
  type StoredRoutingPolicy,
} from "./contracts.ts";
import { buildModelOptions } from "./models.ts";
import { parsePolicy } from "./policy.ts";
import { recommendPolicy } from "./recommend.ts";
import { chainKeys, formatBrief, resolveRoles, sameModelKey, type CandidateFact, type RoutingFacts } from "./resolve.ts";
import { personFile, readPolicyFile, resetPolicy, savePolicy } from "./store.ts";

const MAX_BODY_BYTES = 64 * 1024;
const UNAVAILABLE_TEXT =
  "Model routing is unavailable: the Usage package is disabled. Choose from the user's favorites, or omit model on agent.spawn for Polyth Auto.";

const keyOf = (row: { harnessId: string; providerID: string; modelID: string }) =>
  `${row.harnessId}::${row.providerID}/${row.modelID}`;

const invalidInput = (message: string) => Object.assign(new Error(message), { code: "invalid-input" });

const publicError = (cause: unknown): { status: number; code: string; message: string } => {
  const code = typeof (cause as { code?: unknown })?.code === "string" ? (cause as { code: string }).code : "unavailable";
  const message = cause instanceof Error ? cause.message : "Orchestration is unavailable";
  if (code === "invalid-input") return { status: 400, code, message };
  if (code === "conflict") return { status: 409, code, message };
  console.error("[polyth] orchestration failed", cause);
  return { status: 503, code: "unavailable", message: "Orchestration is unavailable" };
};

interface HarnessRegistryLike {
  get(id: string): unknown;
  providers?(): Array<{ descriptor: { id: string; name: string; accountLabel?: string } }>;
}

/** What the person's policy asks of the ranked list, in either mode: never
 *  lists (models and harnesses) and their own order. */
export function listOptions(policy: RoutingPolicy): Pick<ServerModelRoutingOptions, "exclude" | "excludeHarnesses" | "order"> {
  const rules = Object.entries(policy.harnesses);
  const never = rules.filter(([, rule]) => rule === "never").map(([id]) => id);
  const moves = Object.fromEntries(rules.filter(([, rule]) => rule !== "never")) as Record<string, "prefer" | "avoid">;
  const order: ServerModelRoutingOrder = {
    ...(policy.pinned.length ? { pin: policy.pinned } : {}),
    ...(policy.demoted.length ? { demote: policy.demoted } : {}),
    ...(Object.keys(moves).length ? { harnesses: moves } : {}),
  };
  return {
    ...(policy.excluded.length ? { exclude: policy.excluded } : {}),
    ...(never.length ? { excludeHarnesses: never } : {}),
    ...(Object.keys(order).length ? { order } : {}),
  };
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const file = (space: SpaceContext) => personFile(host.spaceStorage(space).packageDir(ORCHESTRATION_PACKAGE_ID), space.userId);
  const warned = new Set<string>();

  const readSaved = (space: SpaceContext): StoredRoutingPolicy => {
    const { policy, corrupt } = readPolicyFile(file(space));
    if (corrupt && !warned.has(file(space))) {
      warned.add(file(space));
      console.warn("[orchestration] a policy file is unreadable; using the default policy");
    }
    return policy;
  };

  /** Live facts for the chain keys of `policy` through the Usage routing service. */
  async function factsFor(space: SpaceContext, policy: RoutingPolicy): Promise<{ facts: RoutingFacts; report?: ServerModelRoutingReport }> {
    const routing = host.services.get(SERVER_MODEL_ROUTING);
    if (!routing) return { facts: { candidates: new Map(), routingAvailable: false } };
    const chain = chainKeys(policy);
    // Excluded keys ride along (within the 50-pair bound) so an alias of an
    // excluded model is recognised by what it runs.
    const pairs = [...new Set([...chain, ...policy.excluded])].slice(0, 50);
    const report = chain.length ? await routing.candidates(space, { pairs, limit: 50 }) : undefined;
    const candidates = new Map<string, CandidateFact>();
    const excludedModels = new Set<string>();
    for (const row of report?.candidates ?? []) {
      candidates.set(keyOf(row), row);
      if (row.runs && policy.excluded.includes(keyOf(row))) excludedModels.add(sameModelKey(row.harnessId, row.runs));
    }
    return {
      facts: {
        candidates,
        routingAvailable: true,
        ...(report?.catalogUnavailable ? { catalogUnavailable: true } : {}),
        ...(excludedModels.size ? { excludedModels } : {}),
      },
      ...(report ? { report } : {}),
    };
  }

  async function catalogNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    try {
      const rows = await host.services.get(SERVER_RUNTIME_CATALOG)?.models({ maxAgeMs: 60_000 });
      for (const row of rows ?? []) if (row.harnessId) names.set(keyOf({ harnessId: row.harnessId, providerID: row.providerID, modelID: row.modelID }), row.name);
    } catch {
      // names fall back to model ids
    }
    return names;
  }

  async function resolved(space: SpaceContext, policy: RoutingPolicy, harnessId?: string) {
    const [{ facts }, names] = await Promise.all([factsFor(space, policy), catalogNames()]);
    const full: RoutingFacts = { ...facts, names };
    const now = Date.now();
    return { roles: resolveRoles(policy, full, { now, ...(harnessId ? { harnessId } : {}) }), now, names };
  }

  /** Harnesses a rule can name: the registered ones plus any the policy names. */
  function harnessList(policy: RoutingPolicy): OrchestrationState["harnesses"] {
    const registry = host.services.get(serverServiceKey<HarnessRegistryLike>("harnesses"));
    const out = new Map<string, OrchestrationState["harnesses"][number]>();
    for (const provider of registry?.providers?.() ?? []) {
      const { id, name, accountLabel } = provider.descriptor;
      const account = accountLabel?.trim();
      out.set(id, { id, name: account && !name.includes(account) ? `${name} · ${account}` : name, available: true });
    }
    for (const id of Object.keys(policy.harnesses)) if (!out.has(id)) out.set(id, { id, name: id, available: false });
    return [...out.values()];
  }

  async function stateFor(space: SpaceContext, saved: StoredRoutingPolicy, draft: RoutingPolicy): Promise<OrchestrationState> {
    const routing = host.services.get(SERVER_MODEL_ROUTING);
    const { roles, now, names } = await resolved(space, draft);
    // Every listed row (up to 50) for the page; the text keeps an agent's exact cut.
    const report = routing
      ? await routing.candidates(space, { ...listOptions(draft), limit: 50, textLimit: AGENT_SHORTLIST_ROWS })
      : undefined;
    const brief = draft.mode === "roles" ? formatBrief(draft, roles, now) : undefined;
    const reportText = report?.text ?? UNAVAILABLE_TEXT;
    const rows = report?.candidates ?? [];
    return {
      policy: saved,
      generatedAt: now,
      roles,
      routingAvailable: Boolean(routing),
      harnesses: harnessList(draft),
      shortlist: {
        agentRows: Math.min(AGENT_SHORTLIST_ROWS, rows.length),
        rows: rows.map((row) => ({
          key: keyOf(row),
          harnessId: row.harnessId,
          providerID: row.providerID,
          modelID: row.modelID,
          name: names.get(keyOf(row)) ?? row.modelID,
          ...(row.runs ? { runs: row.runs } : {}),
          favorite: row.favorite,
          turns: row.turns,
          sessions: row.sessions,
          failed: row.failed,
          ...(row.lastUsedAt !== undefined ? { lastUsedAt: row.lastUsedAt } : {}),
          available: row.available,
          listed: row.listed,
          blocked: row.blocked,
          ...(row.blockedUntil !== undefined ? { blockedUntil: row.blockedUntil } : {}),
          ...(row.quotaUsed !== undefined ? { quotaUsed: row.quotaUsed } : {}),
          ...(row.quotaWindow ? { quotaWindow: row.quotaWindow } : {}),
          ...(row.harnessName ? { harnessName: row.harnessName } : {}),
          ...(row.favoriteIndex !== undefined ? { favoriteIndex: row.favoriteIndex } : {}),
          ...(row.placed ? { placed: row.placed } : {}),
          ...(row.quotaWindows?.length ? { quotaWindows: row.quotaWindows } : {}),
        })),
        quotas: report?.quotas ?? [],
        omitted: report?.omitted ?? 0,
        unlisted: report?.unlisted ?? 0,
        excluded: report?.excluded ?? 0,
        windowDays: report?.windowDays ?? 0,
        ...(report?.catalogUnavailable ? { catalogUnavailable: true } : {}),
      },
      agentText: brief ? `${brief}\n\n${reportText}` : reportText,
    };
  }

  async function modelOptions(space: SpaceContext) {
    let catalog;
    try {
      catalog = await host.services.get(SERVER_RUNTIME_CATALOG)?.models({ maxAgeMs: 60_000 });
    } catch {
      catalog = undefined;
    }
    const routing = host.services.get(SERVER_MODEL_ROUTING);
    const report = routing ? await routing.candidates(space, { limit: 50 }) : undefined;
    const harnesses = host.services.get(serverServiceKey<HarnessRegistryLike>("harnesses"));
    return buildModelOptions({
      catalog,
      favorites: host.services.get(SERVER_MODEL_FAVORITES)?.favorites(space.userId) ?? [],
      used: (report?.candidates ?? []).map((row) => ({
        harnessId: row.harnessId,
        providerID: row.providerID,
        modelID: row.modelID,
        turns: row.turns,
        failed: row.failed,
        ...(row.runs ? { runs: row.runs } : {}),
      })),
      available: (harnessId) => Boolean(harnesses?.get(harnessId)),
    });
  }

  const routes: RouteHandler = async (request) => {
    const { path, method, space, json } = request;
    if (path !== ORCHESTRATION_API && !path.startsWith(`${ORCHESTRATION_API}/`)) return false;
    const sub = path.slice(ORCHESTRATION_API.length);
    const known =
      (sub === "" && method === "GET")
      || (sub === "/preview" && method === "POST")
      || (sub === "/policy" && (method === "PUT" || method === "DELETE"))
      || (sub === "/models" && method === "GET")
      || (sub === "/recommend" && method === "POST");
    if (!known) return false;
    try {
      const body = method === "POST" || method === "PUT" ? await request.body() : {};
      if (JSON.stringify(body).length > MAX_BODY_BYTES) throw invalidInput("Request body is too large");
      if (sub === "") {
        const saved = readSaved(space);
        json(200, await stateFor(space, saved, saved));
      } else if (sub === "/preview") {
        const draft = parsePolicy(body.policy);
        json(200, await stateFor(space, readSaved(space), draft));
      } else if (sub === "/policy" && method === "PUT") {
        const saved = await savePolicy(file(space), body.policy, body.expectedRevision);
        json(200, await stateFor(space, saved, saved));
      } else if (sub === "/policy") {
        const saved = await resetPolicy(file(space));
        json(200, await stateFor(space, saved, saved));
      } else if (sub === "/models") {
        json(200, await modelOptions(space));
      } else {
        const { models } = await modelOptions(space);
        json(200, { policy: recommendPolicy(readSaved(space), models) });
      }
    } catch (cause) {
      const error = publicError(cause);
      json(error.status, { error: error.code, message: error.message });
    }
    return true;
  };

  // Provided at registration (the registry has no withdraw), so the service
  // itself goes quiet while the package is disabled: agents then get Polyth's
  // automatic ranking, exactly as if the package were not installed.
  let active = false;
  host.services.provide(SERVER_DELEGATION_POLICY, {
    async brief(space, options) {
      if (!active) return undefined;
      const policy = readSaved(space);
      const list = listOptions(policy);
      const shaped = {
        exclude: policy.excluded,
        ...(list.excludeHarnesses ? { excludeHarnesses: [...list.excludeHarnesses] } : {}),
        ...(list.order ? { order: list.order } : {}),
      };
      // Auto mode: no policy lines, but the never lists and the person's own
      // order still shape the ranked list agents get.
      if (policy.mode === "auto") return Object.keys(list).length ? { text: "", ...shaped } : undefined;
      const { roles, now } = await resolved(space, policy, options?.harnessId);
      return { text: formatBrief(policy, roles, now), ...shaped };
    },
    async route(space, roleId, options) {
      if (!active) return undefined;
      const policy = readSaved(space);
      if (policy.mode !== "roles") return undefined;
      const { roles } = await resolved(space, policy);
      const role = roles.find((entry) => entry.id === roleId);
      if (!role?.enabled) return undefined;
      const skip = new Set(options?.exclude ?? []);
      const choice = role.choices.find((entry) =>
        (entry.status === "ready" || entry.status === "unverified") && !skip.has(entry.key));
      return choice
        ? { harnessId: choice.harnessId, providerID: choice.providerID, modelID: choice.modelID }
        : undefined;
    },
  });

  return {
    remoteAccess: localOnlyRemoteAccess([ORCHESTRATION_PACKAGE_ID]),
    routes,
    onEnable() { active = true; },
    onDisable() { active = false; },
  };
}
