// Several native logins of one harness. Every extra account is a private
// directory that the harness CLI is pointed at (`CLAUDE_CONFIG_DIR`,
// `CODEX_HOME`, a private `HOME`, ...), and it registers as its own
// `<family>-<account>` harness, so a session resumes on the account that owns
// its native transcript and moving accounts is an ordinary harness switch.
//
// The account list is deployment-wide host state, like the CLI credentials it
// points to: it lives in the owning package's shared storage, not in a Space,
// and only a `local-trusted` deployment may add, rename or remove accounts.
// The instance owner manages every account and may also add private ones for
// itself; an account the owner gave `harnesses.manage` or `harnesses.personal`
// may add private accounts that only it sees and uses (`ownerUserId`). The
// owner and harness managers may limit a shared account to some people and
// Spaces (`allowedUserIds` / `allowedSpaceIds`).
import { lstat, mkdir, readdir, readFile, readlink, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
    allowedHarnessesFor,
    hasHarnessManagerAuthority as authorizedManager,
    hasInstanceOwnerAuthority,
    hasPersonalHarnessAuthority,
    requireHarnessManagerAuthority,
    requirePersonalHarnessAuthority,
} from "@polyth/contracts/instance-authority";
import {
    allowsInteractiveProviderAuth,
    harnessUsableByUser,
    normalizeHarnessAccessList,
    type DeploymentProfile,
    type Disposable,
    type HarnessAccountsRef,
    type HarnessProvider,
    type HarnessRegistry,
    type RouteHandler,
} from "@polyth/contracts";

export interface HarnessAccount {
    /** Directory slug; also the suffix of the harness id. */
    id: string;
    harnessId: string;
    name: string;
    /** The user who added this private account; absent = shared. */
    ownerUserId?: string;
    /** A shared account usable only by these people; absent = everyone. */
    allowedUserIds?: string[];
    /** A shared account usable only in these Spaces; absent = every Space. */
    allowedSpaceIds?: string[];
}
/** Who may use a shared account; `undefined` lists mean no restriction. */
export interface HarnessAccountAccess {
    allowedUserIds?: string[];
    allowedSpaceIds?: string[];
}
/** An account together with its private native directory. */
export interface ResolvedHarnessAccount extends HarnessAccount {
    dir: string;
}
export interface HarnessAccountStatus {
    /** `"unknown"` when the CLI gave no verifiable answer. */
    loggedIn: boolean | "unknown";
    email?: string;
    plan?: string;
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_ACCOUNTS = 16;
/** Private accounts one user may add. */
const MAX_PRIVATE_ACCOUNTS = 4;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,199}$/;
/** Records which user a private account directory belongs to, so a removed
 *  account's login is only ever restored to the same user. */
const OWNER_MARKER = ".polyth-account-owner";

export const normalizeAccountName = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const name = value.replace(/\s+/g, " ").trim();
    return name && name.length <= 60 && !/[\u0000-\u001f\u007f]/.test(name) ? name : undefined;
};

const slugBase = (name: string): string =>
    name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "account";

const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

/** Validated allowlists of a stored row or a request body; empty = none. */
const accessOf = (row: Record<string, unknown>): HarnessAccountAccess => {
    const allowedUserIds = normalizeHarnessAccessList(row.allowedUserIds, "allowedUserIds");
    const allowedSpaceIds = normalizeHarnessAccessList(row.allowedSpaceIds, "allowedSpaceIds");
    return { ...(allowedUserIds ? { allowedUserIds } : {}), ...(allowedSpaceIds ? { allowedSpaceIds } : {}) };
};
const withoutAccess = <T extends HarnessAccount>({ allowedUserIds: _users, allowedSpaceIds: _spaces, ...rest }: T): Omit<T, "allowedUserIds" | "allowedSpaceIds"> => rest;

export function createHarnessAccountStore(options: {
    storageDir: string;
    family: string;
    label?: string;
}) {
    const { storageDir, family } = options;
    const label = options.label ?? family;
    const file = join(storageDir, `${family}-accounts.json`);
    const root = join(storageDir, `${family}-accounts`);
    // One in-process mutation chain; the list is tiny and has one writer.
    let chain: Promise<unknown> = Promise.resolve();
    const serial = <T>(task: () => Promise<T>): Promise<T> => {
        const next = chain.then(task, task);
        chain = next.catch(() => {});
        return next;
    };
    const dir = (account: Pick<HarnessAccount, "id">) => join(root, account.id);
    const list = async (): Promise<ResolvedHarnessAccount[]> => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(await readFile(file, "utf8"));
        } catch {
            return [];
        }
        if (!Array.isArray(parsed)) return [];
        const seen = new Set<string>();
        return parsed.flatMap((row): ResolvedHarnessAccount[] => {
            const id = (row as { id?: unknown })?.id;
            const name = normalizeAccountName((row as { name?: unknown })?.name);
            const owner = (row as { ownerUserId?: unknown })?.ownerUserId;
            if (typeof id !== "string" || !ID.test(id) || id === "default" || !name || seen.has(id)) return [];
            // A malformed owner must never turn a private login into a shared one.
            if (owner !== undefined && (typeof owner !== "string" || !OWNER.test(owner))) return [];
            // Nor may a malformed allowlist open a restricted one to everyone.
            let access: HarnessAccountAccess;
            try {
                access = owner ? {} : accessOf(row as Record<string, unknown>);
            } catch {
                return [];
            }
            seen.add(id);
            return [{ id, harnessId: `${family}-${id}`, name, ...(owner ? { ownerUserId: owner } : access), dir: dir({ id }) }];
        });
    };
    const save = async (accounts: readonly HarnessAccount[]) => {
        await mkdir(storageDir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(accounts.map(({ id, name, ownerUserId, allowedUserIds, allowedSpaceIds }) => ({
            id,
            name,
            ...(ownerUserId ? { ownerUserId } : {
                ...(allowedUserIds?.length ? { allowedUserIds } : {}),
                ...(allowedSpaceIds?.length ? { allowedSpaceIds } : {}),
            }),
        })), null, 2), { mode: 0o600 });
        await rename(tmp, file);
    };
    /** Whose login a (possibly removed) account directory holds: `null` for
     *  none on disk, `""` for a shared one, otherwise the owning user. */
    const directoryOwner = async (id: string): Promise<string | null> => {
        const info = await lstat(dir({ id })).catch(() => undefined);
        if (!info) return null;
        return (await readFile(join(dir({ id }), OWNER_MARKER), "utf8").catch(() => "")).trim();
    };
    /** A free id whose directory, if a removed account left one, belongs to
     *  the same owner; another user's login is never handed out. */
    const freeId = async (name: string, taken: ReadonlySet<string>, ownerUserId: string | undefined): Promise<string> => {
        const base = slugBase(name);
        for (let n = 1; ; n++) {
            const id = n === 1 ? base : `${base}-${n}`;
            if (taken.has(id) || id === "default") continue;
            const owner = await directoryOwner(id);
            if (owner === null || owner === (ownerUserId ?? "")) return id;
        }
    };
    /** Persist `next`, then let the harness apply it; a refusal restores `previous`. */
    const commit = async (previous: readonly HarnessAccount[], next: readonly HarnessAccount[], apply: () => Promise<void>) => {
        await save(next);
        try {
            await apply();
        } catch (error) {
            await save(previous);
            // Bring the registry back in line with the restored list.
            await apply().catch(() => {});
            throw error;
        }
    };
    return {
        family,
        list,
        dir,
        add: (name: string, apply: () => Promise<void>, ownerUserId?: string) => serial(async () => {
            const accounts = await list();
            if (accounts.length >= MAX_ACCOUNTS) throw coded(`Too many ${label} accounts`, "invalid-input");
            if (ownerUserId !== undefined) {
                if (!OWNER.test(ownerUserId)) throw coded("Invalid account owner", "invalid-input");
                if (accounts.filter((account) => account.ownerUserId === ownerUserId).length >= MAX_PRIVATE_ACCOUNTS) {
                    throw coded(`You can add up to ${MAX_PRIVATE_ACCOUNTS} ${label} accounts`, "invalid-input");
                }
            }
            const id = await freeId(name, new Set(accounts.map((account) => account.id)), ownerUserId);
            const account: ResolvedHarnessAccount = { id, harnessId: `${family}-${id}`, name, ...(ownerUserId ? { ownerUserId } : {}), dir: dir({ id }) };
            await mkdir(account.dir, { recursive: true, mode: 0o700 });
            if (ownerUserId) await writeFile(join(account.dir, OWNER_MARKER), ownerUserId, { mode: 0o600 });
            await commit(accounts, [...accounts, account], apply);
            return account;
        }),
        rename: (id: string, name: string, apply: () => Promise<void>) => serial(async () => {
            const accounts = await list();
            const account = accounts.find((row) => row.id === id);
            if (!account) throw coded(`${label} account not found`, "not-found");
            await commit(accounts, accounts.map((row) => row.id === id ? { ...row, name } : row), apply);
            return { ...account, name };
        }),
        /** Replace who may use a shared account; private accounts have no list. */
        setAccess: (id: string, access: HarnessAccountAccess, apply: () => Promise<void>) => serial(async () => {
            const accounts = await list();
            const account = accounts.find((row) => row.id === id);
            if (!account) throw coded(`${label} account not found`, "not-found");
            if (account.ownerUserId) throw coded("A private account is used only by the person who added it", "invalid-input");
            const next = { ...withoutAccess(account), ...accessOf(access as Record<string, unknown>) };
            await commit(accounts, accounts.map((row) => row.id === id ? next : row), apply);
            return next;
        }),
        /** Drops the account from the list. Its directory (credentials and
         *  transcripts) stays on disk, so re-adding the same name restores it
         *  for the same owner only. */
        remove: (id: string, apply: () => Promise<void>) => serial(async () => {
            const accounts = await list();
            if (!accounts.some((row) => row.id === id)) throw coded(`${label} account not found`, "not-found");
            await commit(accounts, accounts.filter((row) => row.id !== id), apply);
        }),
    };
}
export type HarnessAccountStore = ReturnType<typeof createHarnessAccountStore>;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
/** `cmd.exe` has no escape for `"` inside quotes, and Windows paths cannot
 *  contain one; anything with a space or a cmd metacharacter is quoted. */
const cmdQuote = (value: string) => {
    if (value.includes('"')) throw coded("A Windows command argument cannot contain a double quote", "invalid-input");
    return value === "" || /[\s&|<>^(),;=%!]/.test(value) ? `"${value}"` : value;
};
/** A command line for the server platform's system shell, which is what the
 *  harness setup terminal runs it through (`/bin/sh -c`, `cmd.exe /d /s /c`).
 *  That shell has no login profile, so callers pass the resolved executable
 *  rather than a bare name. */
export const harnessCommandLine = (
    argv: readonly string[],
    env: Readonly<Record<string, string>> = {},
    platform: NodeJS.Platform = process.platform,
): string => platform === "win32"
    ? [...Object.entries(env).map(([name, value]) => {
        if (value.includes('"')) throw coded("A Windows environment value cannot contain a double quote", "invalid-input");
        return `set "${name}=${value}"`;
    }), argv.map(cmdQuote).join(" ")].join(" && ")
    : [...Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}`), ...argv.map(shellQuote)].join(" ");

const contains = (root: string, candidate: string): boolean => {
    const child = relative(resolve(root), resolve(candidate));
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
};

/** Link one real entry into `link` without copying it. A real file or
 *  directory already at `link` is never replaced. */
const linkEntry = async (target: string, link: string): Promise<void> => {
    const existing = await lstat(link).catch(() => undefined);
    if (existing?.isSymbolicLink()) {
        const current = await readlink(link).catch(() => undefined);
        if (current !== undefined && resolve(dirname(link), current) === resolve(target)) return;
        await unlink(link);
    } else if (existing) {
        return;
    }
    const info = await stat(target).catch(() => undefined);
    if (!info) return;
    await symlink(target, link, info.isDirectory() ? (process.platform === "win32" ? "junction" : "dir") : "file")
        .catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
};

/**
 * Make `root` a stand-in for the real directory `real` (a home or an XDG
 * config root): every real entry is linked in, except the `own` names, which
 * stay private to the account. Tools the agent runs therefore keep their git,
 * ssh and package-manager state while the harness reads only the account's
 * own credentials. Idempotent; call it before each launch so entries created
 * later in the real directory show up too.
 */
export async function linkAccountOverlay(input: { root: string; real: string; own: readonly string[] }): Promise<void> {
    const { root, real } = input;
    if (resolve(root) === resolve(real)) throw coded("An account overlay cannot replace the real directory", "invalid-path");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw coded(`Account directory is not a private directory: ${root}`, "invalid-path");
    const own = new Set(input.own);
    for (const name of await readdir(real).catch(() => [] as string[])) {
        if (own.has(name)) continue;
        const target = join(real, name);
        // Never link an ancestor of the overlay into itself (walk loop).
        if (contains(target, root)) continue;
        await linkEntry(target, join(root, name));
    }
    for (const name of own) {
        const path = join(root, name);
        const existing = await lstat(path).catch(() => undefined);
        // A link to the real credentials would silently share the login.
        if (existing?.isSymbolicLink()) await unlink(path);
    }
}

export interface HarnessAccountFamilyOptions {
    /** The default harness id, also the prefix of every account harness id. */
    family: string;
    /** Display name of the default harness, for example `Codex`. */
    label: string;
    /** The owning package id; the routes live under `/api/<packageId>/accounts`. */
    packageId: string;
    /** The owning package's shared storage. Without it only the default
     *  harness registers. */
    storageDir?: string;
    deployment: DeploymentProfile;
    registry(): HarnessRegistry;
    /** Build the default provider (`account` undefined) or an account's
     *  provider. An account provider's descriptor id must be `account.harnessId`. */
    createProvider(account?: ResolvedHarnessAccount): HarnessProvider;
    /** The CLI's own local sign-in report. Must never run a model turn. */
    status(account?: ResolvedHarnessAccount): Promise<HarnessAccountStatus>;
    /** Terminal command that signs this login in, or undefined if the CLI has none. */
    signInCommand(account?: ResolvedHarnessAccount): string | undefined;
    /** The same sign-in through a device code, for a browser that is not on
     *  this machine; omit when `signInCommand` works from any browser. */
    deviceSignInCommand?(account?: ResolvedHarnessAccount): string | undefined;
    /** Bring an account directory into the shape its CLI needs. Runs before
     *  every status read and is expected to be called before each launch. */
    prepare?(account: ResolvedHarnessAccount): Promise<void>;
    /** Limits family Usage reads this account under, if it supports one. */
    limitsFamily?: string;
    /** Why extra accounts cannot work on this host (for example a CLI that
     *  ignores the override on this platform). Only the default registers. */
    unsupported?: string;
}

export interface HarnessAccountsRow extends HarnessAccount {
    /** The caller may rename and remove this account. */
    removable: boolean;
    /** Only one user sees and uses this account. */
    private?: boolean;
    /** A private account the caller added. */
    mine?: boolean;
    /** The caller may run chats on it in the current Space. */
    usable: boolean;
    /** The caller may change who uses this shared account (`allowedUserIds` /
     *  `allowedSpaceIds` are then included; absent = everyone/every Space). */
    accessEditable?: boolean;
    signInCommand?: string;
    status: HarnessAccountStatus;
}

/** Give a provider its account identity without changing how it runs. */
const decorate = (
    provider: HarnessProvider,
    ref: HarnessAccountsRef,
    label: string,
    account: ResolvedHarnessAccount | undefined,
    signInCommand: () => string | undefined,
    deviceSignInCommand: (() => string | undefined) | undefined,
    limitsFamily: string | undefined,
): HarnessProvider => {
    const expected = account?.harnessId ?? ref.family;
    if (provider.descriptor.id !== expected) throw coded(`Account provider must register as ${expected}`, "invalid-input");
    const descriptor = provider.descriptor;
    const fallbackSignIn = descriptor.signInCommand;
    const fallbackDeviceSignIn = descriptor.deviceSignInCommand;
    // Getters, so a rename shows up without re-registering a harness that may
    // still hold live session leases.
    Object.defineProperties(descriptor, {
        accounts: { value: ref, enumerable: true, configurable: true },
        ...(account ? {
            name: { get: () => `${label} · ${account.name}`, enumerable: true, configurable: true },
            accountLabel: { get: () => account.name, enumerable: true, configurable: true },
        } : {}),
        // A private login is never picked for someone by Auto.
        ...(account?.ownerUserId ? {
            accountOwnerUserId: { value: account.ownerUserId, enumerable: true, configurable: true },
            autoSelect: { value: false, enumerable: true, configurable: true },
        } : {}),
        // A shared account's allowlists can change while it holds leases, so
        // they are read live; a restricted one is never picked by Auto either,
        // because Auto does not know who it picks for.
        ...(account && !account.ownerUserId ? (() => {
            const autoSelect = descriptor.autoSelect;
            return {
                accountAllowedUserIds: { get: () => account.allowedUserIds, enumerable: true, configurable: true },
                accountAllowedSpaceIds: { get: () => account.allowedSpaceIds, enumerable: true, configurable: true },
                autoSelect: {
                    get: () => account.allowedUserIds || account.allowedSpaceIds ? false : autoSelect,
                    enumerable: true,
                    configurable: true,
                },
            };
        })() : {}),
        signInCommand: { get: () => signInCommand() ?? fallbackSignIn, enumerable: true, configurable: true },
        deviceSignInCommand: { get: () => deviceSignInCommand?.() ?? fallbackDeviceSignIn, enumerable: true, configurable: true },
    });
    if (account && limitsFamily && !provider.limitsAccount) {
        provider.limitsAccount = () => ({ family: limitsFamily, configDir: account.dir });
    }
    return provider;
};

/**
 * Registers the default harness and one harness per stored account, and
 * serves the local-only account routes. The package returns `routes`,
 * `onEnable` and `onDisable` from its server entry.
 */
export function createHarnessAccountFamily(options: HarnessAccountFamilyOptions) {
    const { family } = options;
    // Why extra accounts are off on this host, if they are.
    const unavailable = options.unsupported ?? (options.storageDir ? undefined : `${options.label} account storage is unavailable`);
    const store = options.storageDir && !unavailable
        ? createHarnessAccountStore({ storageDir: options.storageDir, family, label: options.label })
        : undefined;
    const endpoint = `/api/${options.packageId}/accounts`;
    const ref: HarnessAccountsRef = { family, endpoint };
    const registrations = new Map<string, { account?: ResolvedHarnessAccount; registration: Disposable }>();
    let enabled = false;
    const register = (account?: ResolvedHarnessAccount) => {
        const provider = decorate(
            options.createProvider(account),
            ref,
            options.label,
            account,
            () => options.signInCommand(account),
            options.deviceSignInCommand ? () => options.deviceSignInCommand!(account) : undefined,
            options.limitsFamily,
        );
        return options.registry().register(provider);
    };
    /** Bring the registry in line with the stored list. */
    const reconcile = async () => {
        if (!enabled) return;
        const wanted = new Map<string, ResolvedHarnessAccount | undefined>([[family, undefined]]);
        for (const account of await store?.list() ?? []) wanted.set(account.harnessId, account);
        const failures: unknown[] = [];
        for (const [id, entry] of registrations) {
            const account = wanted.get(id);
            if (wanted.has(id)) {
                if (entry.account && account) {
                    entry.account.name = account.name;
                    entry.account.allowedUserIds = account.allowedUserIds;
                    entry.account.allowedSpaceIds = account.allowedSpaceIds;
                }
                continue;
            }
            // The registry refuses while the harness still holds session
            // leases; the error reaches the caller, who restores the account.
            try {
                await entry.registration.dispose();
                registrations.delete(id);
            } catch (error) {
                failures.push(error);
            }
        }
        for (const [id, account] of wanted) {
            if (registrations.has(id)) continue;
            try {
                if (account) await options.prepare?.(account);
                registrations.set(id, { ...(account ? { account } : {}), registration: register(account) });
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, `Some ${options.label} accounts could not be applied`);
    };
    let syncing: Promise<void> = Promise.resolve();
    const sync = () => {
        const next = syncing.then(reconcile, reconcile);
        syncing = next.catch(() => {});
        return next;
    };
    const status = async (account?: ResolvedHarnessAccount): Promise<HarnessAccountStatus> => {
        try {
            if (account) await options.prepare?.(account);
            return await options.status(account);
        } catch {
            return { loggedIn: "unknown" };
        }
    };
    const routes: RouteHandler = async (request) => {
        if (request.path !== endpoint && !request.path.startsWith(`${endpoint}/`)) return false;
        const owner = hasInstanceOwnerAuthority(request);
        const manager = authorizedManager(request);
        const userId = request.space.userId;
        const spaceId = request.space.spaceId;
        const allowed = allowedHarnessesFor(request);
        // May the caller run chats on it here: its own private login, or a
        // shared one its allowlists and the caller's account limits admit.
        const usable = (account: HarnessAccount | undefined, harnessId: string) => harnessUsableByUser({
            id: harnessId,
            ...(account?.ownerUserId ? { accountOwnerUserId: account.ownerUserId } : {}),
            ...(account?.allowedUserIds ? { accountAllowedUserIds: account.allowedUserIds } : {}),
            ...(account?.allowedSpaceIds ? { accountAllowedSpaceIds: account.allowedSpaceIds } : {}),
        }, userId, allowed, spaceId);
        // The instance owner sees every account and managers every shared one
        // (to choose who uses it); anyone else sees their own private ones and
        // the shared ones they may use here.
        const visible = (account: HarnessAccount) => account.ownerUserId
            ? owner || account.ownerUserId === userId
            : owner || manager || usable(account, account.harnessId);
        const editable = (account: HarnessAccount) => owner || (account.ownerUserId !== undefined && account.ownerUserId === userId);
        const accessEditable = (account: HarnessAccount) => manager && !account.ownerUserId;
        const accessFields = (account: HarnessAccount) => ({
            ...(account.allowedUserIds ? { allowedUserIds: account.allowedUserIds } : {}),
            ...(account.allowedSpaceIds ? { allowedSpaceIds: account.allowedSpaceIds } : {}),
        });
        const rest = request.path.slice(endpoint.length + 1);
        const accessPath = rest.endsWith("/access") ? rest.slice(0, -"/access".length) : undefined;
        const id = accessPath ?? rest;
        try {
            if (request.path === endpoint && request.method === "GET") {
                const accounts = (await store?.list() ?? []).filter(visible);
                const [main, ...statuses] = await Promise.all([status(), ...accounts.map((account) => status(account))]);
                const defaultSignIn = options.signInCommand();
                const rows: HarnessAccountsRow[] = [
                    ...(owner || usable(undefined, family) ? [{
                        id: "default", harnessId: family, name: "", removable: false, usable: usable(undefined, family),
                        ...(defaultSignIn ? { signInCommand: defaultSignIn } : {}), status: main!,
                    }] : []),
                    ...accounts.map((account, index) => {
                        const signIn = options.signInCommand(account);
                        return {
                            id: account.id, harnessId: account.harnessId, name: account.name, removable: editable(account),
                            usable: usable(account, account.harnessId),
                            ...(account.ownerUserId ? { private: true } : {}),
                            ...(account.ownerUserId && account.ownerUserId === userId ? { mine: true } : {}),
                            ...(accessEditable(account) ? { accessEditable: true, ...accessFields(account) } : {}),
                            ...(signIn ? { signInCommand: signIn } : {}), status: statuses[index]!,
                        };
                    }),
                ];
                const manageable = allowsInteractiveProviderAuth(options.deployment) && !unavailable;
                request.json(200, {
                    family,
                    label: options.label,
                    // `manageable` = this caller may add accounts here.
                    manageable: manageable && hasPersonalHarnessAuthority(request),
                    // Only the instance owner adds shared accounts; everyone
                    // else's (and the owner's with `private: true`) are private.
                    canAddShared: manageable && owner,
                    // This caller may change who uses shared accounts.
                    canEditAccess: !!store && manager,
                    ...(unavailable ? { unsupported: unavailable } : {}),
                    accounts: rows,
                });
                return true;
            }
            // Choosing who uses a shared account only narrows access, so it
            // does not need a trusted local deployment.
            if (accessPath !== undefined && ID.test(id) && request.method === "PUT") {
                requireHarnessManagerAuthority(request, `Choosing who uses ${options.label} accounts requires permission from the server owner`);
                if (!store) { request.json(400, { error: unavailable }); return true; }
                const account = (await store.list()).find((row) => row.id === id);
                if (!account || !visible(account)) { request.json(404, { error: `${options.label} account not found` }); return true; }
                const body = await request.body();
                const updated = await store.setAccess(id, { allowedUserIds: body.allowedUserIds, allowedSpaceIds: body.allowedSpaceIds } as HarnessAccountAccess, sync);
                request.json(200, { id: updated.id, harnessId: updated.harnessId, name: updated.name, ...accessFields(updated) });
                return true;
            }
            if (!allowsInteractiveProviderAuth(options.deployment)) {
                request.json(403, { error: `${options.label} accounts can only be managed on a trusted local deployment` });
                return true;
            }
            requirePersonalHarnessAuthority(request, `Adding ${options.label} accounts requires permission from the server owner`);
            if (!store) {
                request.json(400, { error: unavailable });
                return true;
            }
            if (request.path === endpoint && request.method === "POST") {
                const body = await request.body();
                const name = normalizeAccountName(body.name);
                if (!name) { request.json(400, { error: "Account name is required (up to 60 characters)" }); return true; }
                if (body.private !== undefined && typeof body.private !== "boolean") { request.json(400, { error: "private must be true or false" }); return true; }
                // Only the instance owner adds shared accounts, unless it asks
                // for a private one; anyone else's is private to them.
                const account = await store.add(name, sync, owner && body.private !== true ? undefined : userId);
                request.json(201, { id: account.id, harnessId: account.harnessId, name: account.name, ...(account.ownerUserId ? { private: true } : {}) });
                return true;
            }
            if (accessPath === undefined && ID.test(id) && (request.method === "PATCH" || request.method === "DELETE")) {
                const account = (await store.list()).find((row) => row.id === id);
                // Another user's private account does not exist for the caller.
                if (!account || !visible(account)) { request.json(404, { error: `${options.label} account not found` }); return true; }
                if (!editable(account)) { request.json(403, { error: `Only the server owner can change shared ${options.label} accounts` }); return true; }
                if (request.method === "PATCH") {
                    const name = normalizeAccountName((await request.body()).name);
                    if (!name) { request.json(400, { error: "Account name is required (up to 60 characters)" }); return true; }
                    const renamed = await store.rename(id, name, sync);
                    request.json(200, { id: renamed.id, harnessId: renamed.harnessId, name: renamed.name });
                    return true;
                }
                await store.remove(id, sync);
                request.json(200, { ok: true });
                return true;
            }
            request.json(404, { error: "Not found" });
            return true;
        } catch (error) {
            const code = (error as { code?: unknown }).code;
            request.json(code === "not-found" ? 404 : code === "invalid-input" ? 400 : code === "forbidden" ? 403 : 409, {
                error: error instanceof Error ? error.message : String(error),
            });
            return true;
        }
    };
    return {
        store,
        endpoint,
        routes,
        /** Registers the default harness at once (idempotent, like a single
         *  provider package), then every stored account. A broken account
         *  never keeps the default harness from registering. */
        onEnable(): Promise<void> {
            enabled = true;
            if (!registrations.has(family)) registrations.set(family, { registration: register() });
            if (!store) return Promise.resolve();
            return sync().catch((error) => {
                console.warn(`[polyth] ${options.label} accounts could not all be registered`, error);
            });
        },
        async onDisable() {
            enabled = false;
            await syncing;
            const failures: unknown[] = [];
            for (const [id, entry] of registrations) {
                try {
                    await entry.registration.dispose();
                    registrations.delete(id);
                } catch (error) {
                    failures.push(error);
                }
            }
            if (failures.length) {
                // Package lifecycle keeps an enabled descriptor when disable
                // fails; stay enabled so a retry can finish the job.
                enabled = true;
                throw failures.length === 1 ? failures[0] : new AggregateError(failures, `Some ${options.label} harnesses could not be unregistered`);
            }
        },
    };
}
