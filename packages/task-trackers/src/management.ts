import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  SecureSafeService,
  SpaceContext,
  SpaceStorage,
  TaskTrackerAccountDto,
  TaskTrackerProvider,
  TaskTrackerService,
} from "@polyth/contracts";
import { roleAtLeast } from "@polyth/contracts";
import {
  atomicWriteSync,
  resolveConnectionOwner,
  type ConnectionOrigin,
  type PackageServicePolicy,
  type PeopleHost,
} from "@polyth/plugins";
import {
  createDemoClient,
  createTaskTrackerService,
  envCredentials,
  isTaskTrackerProvider,
  PROVIDER_NAMES,
  verifyJiraAccount,
  verifyLinearAccount,
  verifyTrelloAccount,
  type FetchFn,
  type JiraCredentials,
  type LinearCredentials,
  type ProviderClient,
  type TaskTrackerCredentials,
  type TrelloCredentials,
} from "./index.ts";
import {
  mergePreferences,
  normalizeJiraSite,
  normalizePreferences,
  TASK_TRACKER_PROVIDERS,
  type JiraConnectInput,
  type LinearConnectInput,
  type TaskTrackerConnectionDto,
  type TaskTrackerConnectionScope,
  type TaskTrackerManagementDto,
  type TaskTrackerPersonalConnectionDto,
  type TaskTrackerTaskLinkDto,
  type TaskTrackerPreferences,
  type TaskTrackerPreferencesPatch,
  type TrelloConnectInput,
} from "./types.ts";

const PACKAGE_ID = "task-trackers";

export type TaskTrackerVault = Pick<SecureSafeService, "putOpaque" | "getOpaque" | "deleteOpaque">;

const fail = (message: string, code: string): never => {
  throw Object.assign(new Error(message), { code });
};

const text = (value: unknown, field: string, max: number): string => {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean) return fail(`${field} is required`, "invalid-input");
  if (clean.length > max) return fail(`${field} is too long`, "invalid-input");
  return clean;
};

/** A Space service account as stored. `connectedBy` (the Polyth user who
 *  connected it) decides whose "me" that account is; it never leaves the
 *  server. */
type StoredConnection = TaskTrackerConnectionDto & { connectedBy?: string };

interface StoredState {
  preferences: TaskTrackerPreferences;
  /** The Space's service accounts. */
  connections: StoredConnection[];
  /** Legacy per-(Space, person) accounts not yet moved to their owner (§14.4). */
  personal: Record<string, TaskTrackerConnectionDto[]>;
  /** When the last legacy personal account moved to its person. */
  personalMigratedAt?: number;
}

/** A person's own account, stored with the person, outside every Space. */
interface PersonConnection extends TaskTrackerConnectionDto {
  id: string;
  /** The Space a legacy account was moved out of; keeps the migration idempotent. */
  migratedFrom?: string;
}

const stateFile = (storage: SpaceStorage): string =>
  join(storage.packageDir(PACKAGE_ID), "state.json");

const linksFile = (storage: SpaceStorage): string =>
  join(storage.packageDir(PACKAGE_ID), "links.json");

/** Bounds the Space link index; the oldest links fall off first. */
const MAX_LINKS = 500;
/** Bounds one person's accounts across every Space. */
const MAX_PERSONAL = 20;

const CONNECTION_ID = new RegExp(`^(${TASK_TRACKER_PROVIDERS.join("|")})-[a-z0-9-]{1,64}$`);

const serviceVaultKey = (spaceId: string, provider: TaskTrackerProvider): string =>
  `${PACKAGE_ID}:${spaceId}:${provider}`;
/** Where personal secrets lived in the Space vault before they moved to the person. */
const legacyPersonalVaultKey = (spaceId: string, userId: string, provider: TaskTrackerProvider): string =>
  `${PACKAGE_ID}:${spaceId}:user:${encodeURIComponent(userId)}:${provider}`;
const personVaultKey = (connectionId: string): string => `connection:${connectionId}`;

const account = (value: unknown): TaskTrackerAccountDto | null => {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.name !== "string" || !item.name) return null;
  return {
    name: item.name,
    ...(typeof item.email === "string" ? { email: item.email } : {}),
    ...(typeof item.avatarUrl === "string" ? { avatarUrl: item.avatarUrl } : {}),
    ...(typeof item.site === "string" ? { site: item.site } : {}),
  };
};

function connectionOf(value: unknown): TaskTrackerConnectionDto | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const identity = account(item.account);
  if (
    typeof item.provider !== "string" || !isTaskTrackerProvider(item.provider)
    || (item.method !== "api-token" && item.method !== "authorize")
    || !identity
    || typeof item.connectedAt !== "number"
    || typeof item.verifiedAt !== "number"
    || !Number.isSafeInteger(item.revision)
  ) return null;
  return {
    provider: item.provider,
    method: item.method,
    account: identity,
    connectedAt: item.connectedAt,
    verifiedAt: item.verifiedAt,
    revision: item.revision as number,
  };
}

function personConnectionOf(value: unknown): PersonConnection | null {
  const base = connectionOf(value);
  const item = value as Record<string, unknown> | null;
  if (!base || typeof item?.id !== "string" || !CONNECTION_ID.test(item.id) || !item.id.startsWith(`${base.provider}-`)) {
    return null;
  }
  return {
    ...base,
    id: item.id,
    ...(typeof item.migratedFrom === "string" && item.migratedFrom ? { migratedFrom: item.migratedFrom } : {}),
  };
}

function serviceConnectionOf(value: unknown): StoredConnection | null {
  const base = connectionOf(value);
  const connectedBy = (value as Record<string, unknown> | null)?.connectedBy;
  if (!base) return null;
  return typeof connectedBy === "string" && connectedBy ? { ...base, connectedBy } : base;
}

const connectionList = <T extends TaskTrackerConnectionDto>(value: unknown, parse: (item: unknown) => T | null): T[] => {
  const connections = Array.isArray(value)
    ? value.map(parse).filter((item): item is T => item !== null)
    : [];
  return TASK_TRACKER_PROVIDERS
    .map((provider) => connections.find((item) => item.provider === provider))
    .filter((item): item is T => item !== undefined);
};

function load(storage: SpaceStorage): StoredState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(storage), "utf8")) as Record<string, unknown>;
    const personal: Record<string, TaskTrackerConnectionDto[]> = {};
    if (raw.personal && typeof raw.personal === "object" && !Array.isArray(raw.personal)) {
      for (const [userId, value] of Object.entries(raw.personal)) {
        const list = connectionList(value, connectionOf);
        if (userId && list.length > 0) personal[userId] = list;
      }
    }
    return {
      preferences: normalizePreferences(raw.preferences),
      connections: connectionList(raw.connections, serviceConnectionOf),
      personal,
      ...(typeof raw.personalMigratedAt === "number" ? { personalMigratedAt: raw.personalMigratedAt } : {}),
    };
  } catch {
    // Missing or unreadable state falls back to defaults; secrets stay in the vault.
    return { preferences: normalizePreferences(undefined), connections: [], personal: {} };
  }
}

const linkOf = (value: unknown): TaskTrackerTaskLinkDto | null => {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.provider !== "string" || !isTaskTrackerProvider(item.provider)
    || typeof item.taskId !== "string" || !item.taskId
    || typeof item.sessionId !== "string" || !item.sessionId
    || typeof item.linkedAt !== "number"
  ) return null;
  return {
    provider: item.provider,
    taskId: item.taskId,
    taskKey: typeof item.taskKey === "string" && item.taskKey ? item.taskKey : item.taskId,
    sessionId: item.sessionId,
    linkedAt: item.linkedAt,
  };
};

function loadLinks(storage: SpaceStorage): TaskTrackerTaskLinkDto[] {
  try {
    const raw = JSON.parse(readFileSync(linksFile(storage), "utf8")) as unknown;
    return Array.isArray(raw)
      ? raw.map(linkOf).filter((item): item is TaskTrackerTaskLinkDto => item !== null)
      : [];
  } catch {
    return [];
  }
}

function save(storage: SpaceStorage, state: StoredState): void {
  try {
    mkdirSync(storage.packageDir(PACKAGE_ID), { recursive: true });
    atomicWriteSync(stateFile(storage), JSON.stringify(state, null, 2), 0o600);
  } catch {
    fail("Task tracker settings could not be saved", "unavailable");
  }
}

const personFile = (people: PeopleHost, userId: string): string =>
  people.storage(userId, PACKAGE_ID).path("connections.json");

/** Throws when the person's storage is unreachable (e.g. an id that is not a person). */
function loadPerson(people: PeopleHost, userId: string): PersonConnection[] {
  const file = personFile(people, userId);
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { connections?: unknown };
    return Array.isArray(raw.connections)
      ? raw.connections.map(personConnectionOf).filter((item): item is PersonConnection => item !== null)
      : [];
  } catch {
    return [];
  }
}

function savePerson(people: PeopleHost, userId: string, connections: readonly PersonConnection[]): void {
  try {
    atomicWriteSync(personFile(people, userId), JSON.stringify({ version: 1, connections }, null, 2), 0o600);
  } catch {
    fail("Your account could not be saved", "unavailable");
  }
}

type StoredSecret =
  | { provider: "jira"; baseUrl: string; email: string; apiToken: string }
  | { provider: "trello"; apiKey: string; apiToken: string }
  | { provider: "linear"; apiKey: string };

function parseSecret(raw: string | null | undefined, provider: TaskTrackerProvider): StoredSecret | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as StoredSecret;
    return value.provider === provider ? value : null;
  } catch {
    return null;
  }
}

/** Who a tracker call acts for, beyond the Space it runs in. */
export interface TrackerAccess {
  /**
   * The instance owner on `local-trusted`: may also use the installation's
   * env accounts (`JIRA_*` / `TRELLO_*` / `LINEAR_API_KEY`). Nobody else ever does.
   */
  installationOwner?: boolean;
}

/** The person (or nobody) a non-UI call acts for. */
export interface TrackerActor extends TrackerAccess {
  origin: Exclude<ConnectionOrigin, "person-ui">;
  /** `ToolExecutionContext.actorUserId`; absent means system work. */
  userId?: string | undefined;
}

export interface TrackerCallOptions extends TrackerAccess {
  /** A specific personal connection; default: the caller's one enabled in this Space. */
  connectionId?: string;
}

type Refusal = "connect-your-account" | "not-a-member" | "service-not-allowed";

interface Resolution {
  credentials: TaskTrackerCredentials;
  refusals: Partial<Record<TaskTrackerProvider, Refusal>>;
  services: Partial<Record<TaskTrackerProvider, boolean>>;
}

export interface TaskTrackerManagementOptions {
  storage: (space: SpaceContext) => SpaceStorage;
  /** The Space Credential Vault (service accounts); resolved lazily, absent when disabled. */
  vault: () => TaskTrackerVault | undefined;
  /** Person-owned accounts and per-Space enablement (§14.4); absent = no personal accounts. */
  people?: () => PeopleHost | undefined;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchFn;
}

export interface TaskTrackerManagement {
  /**
   * The tracker service the signed-in person (`space.userId`) sees: their own
   * account enabled in this Space, else the Space service account, else (for
   * the instance owner on local-trusted) the env account, else the sandbox.
   */
  trackers(space: SpaceContext, access?: TrackerAccess): TaskTrackerService;
  /**
   * The service an agent turn (or system work) may use for `provider`. Uses the
   * actor's own enabled account, else the Space service account only under the
   * Space policy. Throws a `forbidden` error naming the fix instead of ever
   * using another person's account. Falls back to the sandbox only where the
   * actor's own view would show it too.
   */
  agentTrackers(space: SpaceContext, actor: TrackerActor, provider: TaskTrackerProvider): TaskTrackerService;
  preferences(space: SpaceContext): TaskTrackerPreferences;
  state(space: SpaceContext, access?: TrackerAccess): TaskTrackerManagementDto;
  updatePreferences(space: SpaceContext, patch: TaskTrackerPreferencesPatch, access?: TrackerAccess): TaskTrackerManagementDto;
  connectJira(space: SpaceContext, input: JiraConnectInput, scope?: TaskTrackerConnectionScope, access?: TrackerAccess): Promise<TaskTrackerManagementDto>;
  connectTrello(space: SpaceContext, input: TrelloConnectInput, scope?: TaskTrackerConnectionScope, access?: TrackerAccess): Promise<TaskTrackerManagementDto>;
  connectLinear(space: SpaceContext, input: LinearConnectInput, scope?: TaskTrackerConnectionScope, access?: TrackerAccess): Promise<TaskTrackerManagementDto>;
  verify(space: SpaceContext, provider: TaskTrackerProvider, scope?: TaskTrackerConnectionScope, options?: TrackerCallOptions): Promise<TaskTrackerManagementDto>;
  /** Personal scope deletes the person's account everywhere, not only here. */
  disconnect(space: SpaceContext, provider: TaskTrackerProvider, scope?: TaskTrackerConnectionScope, options?: TrackerCallOptions): TaskTrackerManagementDto;
  /** Turn one of the caller's own accounts on or off in this Space (one per provider is on). */
  setPersonalEnabled(space: SpaceContext, connectionId: string, enabled: boolean, access?: TrackerAccess): TaskTrackerManagementDto;
  /** Space admins only. */
  servicePolicy(space: SpaceContext): PackageServicePolicy;
  /** Space admins only. */
  setServicePolicy(space: SpaceContext, policy: PackageServicePolicy, access?: TrackerAccess): TaskTrackerManagementDto;
  /** Sessions each task was linked or dispatched to, newest first. */
  links(space: SpaceContext): TaskTrackerTaskLinkDto[];
  recordLink(space: SpaceContext, link: Omit<TaskTrackerTaskLinkDto, "linkedAt">): void;
}

const quietly = <T>(read: () => T, fallback: T): T => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

/**
 * Owns tracker state. Space settings and the Space's service accounts live in
 * the Space; a person's own accounts live with the person (`host.people`) and
 * are enabled per Space. Credential values only ever enter a vault's opaque
 * store and are never returned, logged, or included in a DTO.
 */
export function createTaskTrackerManagement(options: TaskTrackerManagementOptions): TaskTrackerManagement {
  const env = options.env ?? process.env;
  const fetchOption = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};
  const peopleHost = (): PeopleHost | undefined => options.people?.();
  // The sandbox keeps its in-memory edits per Space for the life of the process.
  const demos = new Map<string, ProviderClient>();
  const demoFor = (space: SpaceContext) => (provider: TaskTrackerProvider): ProviderClient => {
    const key = `${space.spaceId}:${provider}`;
    let client = demos.get(key);
    if (!client) {
      client = createDemoClient(provider);
      demos.set(key, client);
    }
    return client;
  };

  const requireManager = (space: SpaceContext): void => {
    if (!roleAtLeast(space.role, "admin")) fail("Your Space role cannot change task tracker settings", "forbidden");
  };
  const requirePersonal = (space: SpaceContext): PeopleHost => {
    if (!roleAtLeast(space.role, "member") || !space.userId) {
      fail("Your Space role cannot connect a personal tracker account", "forbidden");
    }
    return peopleHost() ?? fail("This server can't store personal accounts", "unavailable");
  };
  const requireScope = (space: SpaceContext, scope: TaskTrackerConnectionScope): void => {
    if (scope === "space") requireManager(space);
    else requirePersonal(space);
  };
  const requireVault = (): TaskTrackerVault =>
    options.vault() ?? fail("Credential Vault is unavailable, so connections can't be saved", "unavailable");

  const enabledIds = (people: PeopleHost, userId: string, spaceId: string): string[] =>
    quietly(() => people.enabled(userId, spaceId, PACKAGE_ID), []);
  const policyOf = (spaceId: string): PackageServicePolicy => {
    const people = peopleHost();
    return people
      ? quietly(() => people.servicePolicy(spaceId, PACKAGE_ID), { agentsMayUseService: false })
      : { agentsMayUseService: false };
  };

  /** On in this Space, and every other account of the same provider off here. */
  const enableOnly = (
    people: PeopleHost,
    userId: string,
    spaceId: string,
    list: readonly PersonConnection[],
    connection: PersonConnection,
  ): void => {
    people.setEnabled(userId, spaceId, PACKAGE_ID, connection.id, true);
    for (const id of enabledIds(people, userId, spaceId)) {
      if (id !== connection.id && list.some((item) => item.id === id && item.provider === connection.provider)) {
        people.setEnabled(userId, spaceId, PACKAGE_ID, id, false);
      }
    }
  };

  // Moves one legacy `personal[userId]` account into the person's own store.
  // Idempotent: a retry finds the copy by `migratedFrom` instead of duplicating it.
  const migrateOne = (
    people: PeopleHost,
    vault: TaskTrackerVault,
    spaceId: string,
    userId: string,
    connection: TaskTrackerConnectionDto,
  ): void => {
    const legacyKey = legacyPersonalVaultKey(spaceId, userId, connection.provider);
    const secret = parseSecret(vault.getOpaque(legacyKey), connection.provider);
    const list = loadPerson(people, userId);
    const personVault = () => people.vault(userId, PACKAGE_ID);
    let target = list.find((item) => item.migratedFrom === spaceId && item.provider === connection.provider);
    if (!target) {
      // Metadata without a secret was never usable: nothing to move.
      if (!secret) return;
      if (list.length >= MAX_PERSONAL) fail("Too many personal accounts", "invalid-input");
      // A second Space's account for the same service stays a separate
      // connection; merging would silently pick one person's token for both.
      target = {
        ...connection,
        account: { ...connection.account },
        id: `${connection.provider}-${randomUUID()}`,
        migratedFrom: spaceId,
      };
      personVault().putOpaque(personVaultKey(target.id), JSON.stringify(secret));
      try {
        savePerson(people, userId, [...list, target]);
      } catch (cause) {
        try { personVault().deleteOpaque(personVaultKey(target.id)); } catch { /* original error wins */ }
        throw cause;
      }
    } else if (secret && personVault().getOpaque(personVaultKey(target.id)) === null) {
      personVault().putOpaque(personVaultKey(target.id), JSON.stringify(secret));
    }
    // It worked here before, so it stays on here, unless the person left the
    // Space or already has another account of this service on here.
    try {
      const on = enabledIds(people, userId, spaceId);
      const clash = on.some((id) => id !== target.id
        && list.some((item) => item.id === id && item.provider === connection.provider));
      if (!on.includes(target.id) && !clash && people.isMember(userId, spaceId)) {
        people.setEnabled(userId, spaceId, PACKAGE_ID, target.id, true);
      }
    } catch {
      // The account moved; the person can still turn it on in Tasks settings.
    }
    vault.deleteOpaque(legacyKey);
  };

  const migrate = (space: SpaceContext, storage: SpaceStorage, state: StoredState): void => {
    const people = peopleHost();
    const vault = options.vault();
    if (!people || !vault) return;
    let changed = false;
    for (const [userId, list] of Object.entries(state.personal)) {
      const remaining: TaskTrackerConnectionDto[] = [];
      for (const connection of list) {
        try {
          migrateOne(people, vault, space.spaceId, userId, connection);
          changed = true;
        } catch {
          // Kept in the Space and retried on the next read.
          remaining.push(connection);
        }
      }
      if (remaining.length > 0) state.personal[userId] = remaining;
      else delete state.personal[userId];
    }
    if (!changed) return;
    if (Object.keys(state.personal).length === 0) state.personalMigratedAt = Date.now();
    try {
      save(storage, state);
    } catch {
      // The person's copy exists; the next read finds it by `migratedFrom`.
    }
  };

  const loadState = (space: SpaceContext, storage = options.storage(space)): StoredState => {
    const state = load(storage);
    if (Object.keys(state.personal).length > 0) migrate(space, storage, state);
    return state;
  };

  /** The person's account of `provider` enabled in this Space, with its secret. */
  const enabledPersonal = (
    userId: string,
    spaceId: string,
    provider: TaskTrackerProvider,
  ): { connection: PersonConnection; secret: StoredSecret } | undefined => {
    const people = peopleHost();
    if (!people) return undefined;
    return quietly(() => {
      const on = enabledIds(people, userId, spaceId);
      const connection = loadPerson(people, userId).find((item) => item.provider === provider && on.includes(item.id));
      if (!connection) return undefined;
      const secret = parseSecret(people.vault(userId, PACKAGE_ID).getOpaque(personVaultKey(connection.id)), provider);
      return secret ? { connection, secret } : undefined;
    }, undefined);
  };

  const resolve = (
    space: SpaceContext,
    state: StoredState,
    origin: ConnectionOrigin,
    actorUserId: string | undefined,
    access: TrackerAccess,
  ): Resolution => {
    const fromEnv = envCredentials(env);
    const vault = options.vault();
    const people = peopleHost();
    const policy = policyOf(space.spaceId);
    const userId = origin === "system" ? undefined : actorUserId || undefined;
    const result: Resolution = { credentials: {}, refusals: {}, services: {} };
    for (const provider of TASK_TRACKER_PROVIDERS) {
      const personal = userId ? enabledPersonal(userId, space.spaceId, provider) : undefined;
      const service = state.connections.find((item) => item.provider === provider);
      const serviceSecret = service ? parseSecret(vault?.getOpaque(serviceVaultKey(space.spaceId, provider)), provider) : null;
      result.services[provider] = Boolean(service && serviceSecret);
      const owner = resolveConnectionOwner({
        actorUserId: userId,
        spaceId: space.spaceId,
        // The gateway already proved the signed-in person's membership.
        isMember: (id, spaceId) => origin === "person-ui"
          ? id === space.userId && spaceId === space.spaceId
          : Boolean(people && quietly(() => people.isMember(id, spaceId), false)),
        personalEnabled: personal ? [personal.connection.id] : [],
        hasService: result.services[provider] === true,
        policy,
        origin,
      });
      // `connectedBy` names whose "me" the account is: a personal account's
      // owner, or the person who connected the Space service account.
      let chosen: {
        secret: StoredSecret;
        origin: { source: "personal" | "connection"; account: TaskTrackerAccountDto; connectedBy?: string };
      } | undefined;
      if (owner.kind === "personal" && personal && userId) {
        chosen = { secret: personal.secret, origin: { source: "personal", account: personal.connection.account, connectedBy: userId } };
      } else if (owner.kind === "service" && service && serviceSecret) {
        chosen = {
          secret: serviceSecret,
          origin: {
            source: "connection",
            account: service.account,
            ...(service.connectedBy ? { connectedBy: service.connectedBy } : {}),
          },
        };
      }
      if (chosen?.secret.provider === "jira") {
        const { provider: _jira, ...secret } = chosen.secret;
        result.credentials.jira = { ...secret, ...chosen.origin };
      } else if (chosen?.secret.provider === "trello") {
        const { provider: _trello, ...secret } = chosen.secret;
        result.credentials.trello = { ...secret, ...chosen.origin };
      } else if (chosen?.secret.provider === "linear") {
        const { provider: _linear, ...secret } = chosen.secret;
        result.credentials.linear = { ...secret, ...chosen.origin };
      } else if (owner.kind === "refused") {
        // The installation's env account is the instance owner's alone.
        const installation = owner.reason !== "not-a-member" && userId && access.installationOwner === true;
        const fallback = installation ? fromEnv[provider] : undefined;
        if (fallback) (result.credentials as Record<TaskTrackerProvider, typeof fallback>)[provider] = fallback;
        else result.refusals[provider] = owner.reason;
      }
    }
    return result;
  };

  /** `viewerUserId` is the person the board's "Mine" means; none for system work. */
  const serviceFor = (
    space: SpaceContext,
    state: StoredState,
    resolution: Resolution,
    viewerUserId: string | undefined,
  ): TaskTrackerService =>
    createTaskTrackerService({
      ...fetchOption,
      credentials: resolution.credentials,
      preferences: state.preferences,
      demoClient: demoFor(space),
      ...(viewerUserId ? { viewerUserId } : {}),
    });

  const trackersFor = (space: SpaceContext, state: StoredState, access: TrackerAccess = {}): TaskTrackerService =>
    serviceFor(space, state, resolve(space, state, "person-ui", space.userId, access), space.userId || undefined);

  const strip = (item: TaskTrackerConnectionDto): TaskTrackerConnectionDto => ({
    provider: item.provider,
    method: item.method,
    account: { ...item.account },
    connectedAt: item.connectedAt,
    verifiedAt: item.verifiedAt,
    revision: item.revision,
  });

  const snapshot = (space: SpaceContext, state: StoredState, access: TrackerAccess = {}): TaskTrackerManagementDto => {
    const people = peopleHost();
    const canManage = roleAtLeast(space.role, "admin");
    let personalConnections: TaskTrackerPersonalConnectionDto[] = [];
    if (people && space.userId) {
      const on = enabledIds(people, space.userId, space.spaceId);
      personalConnections = quietly(() => loadPerson(people, space.userId), [])
        .map((item) => ({ ...strip(item), id: item.id, enabled: on.includes(item.id) }));
    }
    return {
      preferences: state.preferences,
      connections: state.connections.map(strip),
      personalConnections,
      providers: trackersFor(space, state, access).providers(),
      vaultAvailable: options.vault() !== undefined,
      personalAvailable: people !== undefined,
      canManage,
      canConnect: roleAtLeast(space.role, "member") && Boolean(space.userId),
      ...(canManage ? { agentsMayUseService: policyOf(space.spaceId).agentsMayUseService } : {}),
    };
  };

  const storeService = (
    space: SpaceContext,
    provider: TaskTrackerProvider,
    method: TaskTrackerConnectionDto["method"],
    identity: TaskTrackerAccountDto,
    secret: StoredSecret,
    access: TrackerAccess,
  ): TaskTrackerManagementDto => {
    const vault = requireVault();
    const storage = options.storage(space);
    const state = loadState(space, storage);
    const key = serviceVaultKey(space.spaceId, provider);
    const prior = vault.getOpaque(key);
    const previous = state.connections.find((item) => item.provider === provider);
    const now = Date.now();
    const next: StoredConnection = {
      provider,
      method,
      account: identity,
      connectedAt: previous?.connectedAt ?? now,
      verifiedAt: now,
      revision: (previous?.revision ?? 0) + 1,
      // Whoever saves a service account's credential owns its "me" from then on.
      ...(space.userId ? { connectedBy: space.userId } : {}),
    };
    vault.putOpaque(key, JSON.stringify(secret));
    try {
      state.connections = [...state.connections.filter((item) => item.provider !== provider), next];
      // An admin connecting a service implies they want it on.
      state.preferences = mergePreferences(state.preferences, { providers: { [provider]: true } });
      save(storage, state);
    } catch (cause) {
      try { prior === null ? vault.deleteOpaque(key) : vault.putOpaque(key, prior); } catch { /* original error wins */ }
      throw cause;
    }
    return snapshot(space, state, access);
  };

  // Reconnecting replaces the account enabled here; otherwise a new account is
  // added to the person's list and turned on in this Space only.
  const storePersonal = (
    space: SpaceContext,
    provider: TaskTrackerProvider,
    method: TaskTrackerConnectionDto["method"],
    identity: TaskTrackerAccountDto,
    secret: StoredSecret,
    access: TrackerAccess,
  ): TaskTrackerManagementDto => {
    const people = requirePersonal(space);
    const userId = space.userId;
    const list = loadPerson(people, userId);
    const on = enabledIds(people, userId, space.spaceId);
    const previous = list.find((item) => item.provider === provider && on.includes(item.id));
    if (!previous && list.length >= MAX_PERSONAL) fail("You have too many connected accounts; remove one first", "invalid-input");
    const id = previous?.id ?? `${provider}-${randomUUID()}`;
    const vault = people.vault(userId, PACKAGE_ID);
    const key = personVaultKey(id);
    const prior = vault.getOpaque(key);
    const now = Date.now();
    const next: PersonConnection = {
      id,
      provider,
      method,
      account: identity,
      connectedAt: previous?.connectedAt ?? now,
      verifiedAt: now,
      revision: (previous?.revision ?? 0) + 1,
      ...(previous?.migratedFrom ? { migratedFrom: previous.migratedFrom } : {}),
    };
    vault.putOpaque(key, JSON.stringify(secret));
    try {
      const updated = [...list.filter((item) => item.id !== id), next];
      savePerson(people, userId, updated);
      if (!previous) {
        try {
          enableOnly(people, userId, space.spaceId, updated, next);
        } catch (cause) {
          try { savePerson(people, userId, list); } catch { /* original error wins */ }
          throw cause;
        }
      }
    } catch (cause) {
      try { prior === null ? vault.deleteOpaque(key) : vault.putOpaque(key, prior); } catch { /* original error wins */ }
      throw cause;
    }
    return snapshot(space, loadState(space), access);
  };

  const personalTarget = (
    people: PeopleHost,
    space: SpaceContext,
    provider: TaskTrackerProvider,
    connectionId: string | undefined,
  ): { list: PersonConnection[]; connection: PersonConnection } => {
    const list = loadPerson(people, space.userId);
    const on = enabledIds(people, space.userId, space.spaceId);
    const connection = list.find((item) => item.provider === provider
      && (connectionId ? item.id === connectionId : on.includes(item.id)));
    return { list, connection: connection ?? fail(`${PROVIDER_NAMES[provider]} is not connected`, "not-found") };
  };

  const refusalMessage = (provider: TaskTrackerProvider, reason: Refusal): string => {
    const name = PROVIDER_NAMES[provider];
    if (reason === "not-a-member") {
      return `The person this turn acts for is not a member of this Space, so no ${name} account can be used.`;
    }
    if (reason === "service-not-allowed") {
      return `This turn acts for no one, and this Space doesn't let agents use its shared ${name} account. A Space admin can allow it in Tasks settings.`;
    }
    return `No ${name} account is available to this agent. Connect your ${name} account in Tasks settings and turn it on for this Space; agents use the account of the person who sent the message.`;
  };

  return {
    trackers: (space, access) => trackersFor(space, loadState(space), access),

    agentTrackers(space, actor, provider) {
      const state = loadState(space);
      const resolution = resolve(space, state, actor.origin, actor.userId, actor);
      const refusal = resolution.refusals[provider];
      // The sandbox is what this person would see too; a real account the
      // agent may not use is a refusal, never a silent sandbox.
      if (refusal && (refusal === "not-a-member" || resolution.services[provider] || !state.preferences.demo)) {
        fail(refusalMessage(provider, refusal), "forbidden");
      }
      return serviceFor(space, state, resolution, actor.origin === "system" ? undefined : actor.userId || undefined);
    },

    preferences: (space) => load(options.storage(space)).preferences,
    state: (space, access) => snapshot(space, loadState(space), access),

    updatePreferences(space, patch, access) {
      requireManager(space);
      const storage = options.storage(space);
      const state = loadState(space, storage);
      state.preferences = mergePreferences(state.preferences, patch);
      save(storage, state);
      return snapshot(space, state, access);
    },

    async connectJira(space, input, scope = "space", access = {}) {
      requireScope(space, scope);
      if (scope === "space") requireVault();
      const baseUrl = normalizeJiraSite(text(input.site, "Jira site", 253))
        ?? fail("Enter your Jira site, for example acme.atlassian.net", "invalid-input");
      const credentials: JiraCredentials = {
        baseUrl,
        email: text(input.email, "Email", 254),
        apiToken: text(input.apiToken, "API token", 4096),
      };
      const identity = await verifyJiraAccount({ ...credentials, ...fetchOption });
      const secret: StoredSecret = { provider: "jira", ...credentials };
      return scope === "space"
        ? storeService(space, "jira", "api-token", identity, secret, access)
        : storePersonal(space, "jira", "api-token", identity, secret, access);
    },

    async connectTrello(space, input, scope = "space", access = {}) {
      requireScope(space, scope);
      if (scope === "space") requireVault();
      const credentials: TrelloCredentials = {
        apiKey: text(input.apiKey, "API key", 256),
        apiToken: text(input.token, "Token", 4096),
      };
      if (!/^[a-z0-9]+$/i.test(credentials.apiKey)) fail("Trello API keys contain only letters and digits", "invalid-input");
      const identity = await verifyTrelloAccount({ ...credentials, ...fetchOption });
      const secret: StoredSecret = { provider: "trello", ...credentials };
      return scope === "space"
        ? storeService(space, "trello", "authorize", identity, secret, access)
        : storePersonal(space, "trello", "authorize", identity, secret, access);
    },

    async connectLinear(space, input, scope = "space", access = {}) {
      requireScope(space, scope);
      if (scope === "space") requireVault();
      const credentials: LinearCredentials = { apiKey: text(input.apiKey, "API key", 4096) };
      if (/\s/.test(credentials.apiKey)) fail("A Linear API key is one word without spaces", "invalid-input");
      const identity = await verifyLinearAccount({ ...credentials, ...fetchOption });
      const secret: StoredSecret = { provider: "linear", ...credentials };
      return scope === "space"
        ? storeService(space, "linear", "api-token", identity, secret, access)
        : storePersonal(space, "linear", "api-token", identity, secret, access);
    },

    async verify(space, provider, scope = "space", callOptions = {}) {
      requireScope(space, scope);
      const missing = () => fail(`${PROVIDER_NAMES[provider]} credentials are missing; connect again`, "unavailable");
      const check = (secret: StoredSecret) => secret.provider === "jira"
        ? verifyJiraAccount({ ...secret, ...fetchOption })
        : secret.provider === "trello"
          ? verifyTrelloAccount({ ...secret, ...fetchOption })
          : verifyLinearAccount({ ...secret, ...fetchOption });
      if (scope === "personal") {
        const people = requirePersonal(space);
        const { connection } = personalTarget(people, space, provider, callOptions.connectionId);
        const secret = parseSecret(people.vault(space.userId, PACKAGE_ID).getOpaque(personVaultKey(connection.id)), provider)
          ?? missing();
        const identity = await check(secret);
        // Re-read: the list may have changed while the tracker answered.
        const list = loadPerson(people, space.userId);
        const current = list.find((item) => item.id === connection.id);
        if (current) {
          current.account = identity;
          current.verifiedAt = Date.now();
          savePerson(people, space.userId, list);
        }
        return snapshot(space, loadState(space), callOptions);
      }
      const storage = options.storage(space);
      const state = loadState(space, storage);
      const connection = state.connections.find((item) => item.provider === provider)
        ?? fail(`${PROVIDER_NAMES[provider]} is not connected`, "not-found");
      const secret = parseSecret(options.vault()?.getOpaque(serviceVaultKey(space.spaceId, provider)), provider)
        ?? missing();
      const identity = await check(secret);
      connection.account = identity;
      connection.verifiedAt = Date.now();
      save(storage, state);
      return snapshot(space, state, callOptions);
    },

    disconnect(space, provider, scope = "space", callOptions = {}) {
      requireScope(space, scope);
      if (scope === "personal") {
        const people = requirePersonal(space);
        const { list, connection } = personalTarget(people, space, provider, callOptions.connectionId);
        people.vault(space.userId, PACKAGE_ID).deleteOpaque(personVaultKey(connection.id));
        savePerson(people, space.userId, list.filter((item) => item.id !== connection.id));
        // Other Spaces' enablement of a deleted id is inert: the id never returns.
        quietly(() => people.setEnabled(space.userId, space.spaceId, PACKAGE_ID, connection.id, false), undefined);
        return snapshot(space, loadState(space), callOptions);
      }
      const storage = options.storage(space);
      const state = loadState(space, storage);
      options.vault()?.deleteOpaque(serviceVaultKey(space.spaceId, provider));
      state.connections = state.connections.filter((item) => item.provider !== provider);
      save(storage, state);
      return snapshot(space, state, callOptions);
    },

    setPersonalEnabled(space, connectionId, enabled, access = {}) {
      const people = requirePersonal(space);
      const list = loadPerson(people, space.userId);
      const connection = list.find((item) => item.id === connectionId)
        ?? fail("That account is not one of yours", "not-found");
      if (enabled) enableOnly(people, space.userId, space.spaceId, list, connection);
      else people.setEnabled(space.userId, space.spaceId, PACKAGE_ID, connection.id, false);
      return snapshot(space, loadState(space), access);
    },

    servicePolicy(space) {
      requireManager(space);
      return policyOf(space.spaceId);
    },

    setServicePolicy(space, policy, access = {}) {
      requireManager(space);
      if (typeof policy?.agentsMayUseService !== "boolean") fail("agentsMayUseService must be true or false", "invalid-input");
      const people = peopleHost() ?? fail("This server can't store the Space account policy", "unavailable");
      people.setServicePolicy(space.spaceId, PACKAGE_ID, { agentsMayUseService: policy.agentsMayUseService });
      return snapshot(space, loadState(space), access);
    },

    links: (space) => loadLinks(options.storage(space)),

    recordLink(space, link) {
      const storage = options.storage(space);
      const next: TaskTrackerTaskLinkDto = { ...link, linkedAt: Date.now() };
      const links = [
        next,
        ...loadLinks(storage).filter((item) =>
          !(item.provider === link.provider && item.taskId === link.taskId && item.sessionId === link.sessionId)),
      ].slice(0, MAX_LINKS);
      try {
        mkdirSync(storage.packageDir(PACKAGE_ID), { recursive: true });
        atomicWriteSync(linksFile(storage), JSON.stringify(links), 0o600);
      } catch {
        // The index only decorates the board; session history stays canonical.
      }
    },
  };
}
