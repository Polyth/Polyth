import type { HarnessDescriptor, HarnessReleaseSource, HarnessSnapshot, HarnessUpdateStatus } from "@polyth/contracts";

/** A version split into its numeric core and an optional `-suffix`. */
export type HarnessVersion = { text: string; core: number[]; suffix?: string };

const VERSION_TOKEN = /\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?/;
const PRERELEASE = /^(?:alpha|beta|rc|next|canary|pre|dev)(?:[0-9.]*)?(?:[.-]|$)/i;

/** The first version-looking token of a CLI's `--version` text. */
export function parseHarnessVersion(text: string | undefined): HarnessVersion | undefined {
    const token = text?.match(VERSION_TOKEN)?.[0];
    if (!token)
        return undefined;
    const dash = token.indexOf("-");
    const core = (dash < 0 ? token : token.slice(0, dash)).split(".").map(Number);
    const suffix = dash < 0 ? undefined : token.slice(dash + 1);
    return { text: token, core, ...(suffix ? { suffix } : {}) };
}

function comparePrerelease(left: string, right: string): number {
    const a = left.split(".");
    const b = right.split(".");
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const x = a[index];
        const y = b[index];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const xn = /^\d+$/.test(x);
        const yn = /^\d+$/.test(y);
        if (xn && yn) {
            if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
            continue;
        }
        if (xn !== yn) return xn ? -1 : 1;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

/** Negative when `left` is older, positive when newer. Build hashes after a
 *  dash (CalVer `2026.09.15-d2fe57e`) do not order; prereleases do. */
export function compareHarnessVersions(left: HarnessVersion, right: HarnessVersion): number {
    for (let index = 0; index < Math.max(left.core.length, right.core.length); index++) {
        const a = left.core[index] ?? 0;
        const b = right.core[index] ?? 0;
        if (a !== b) return a < b ? -1 : 1;
    }
    const a = left.suffix && PRERELEASE.test(left.suffix) ? left.suffix : undefined;
    const b = right.suffix && PRERELEASE.test(right.suffix) ? right.suffix : undefined;
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return comparePrerelease(a, b);
}

const NPM_PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const NPM_TAG = /^[A-Za-z0-9._-]+$/;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_NPM_BYTES = 256 * 1024;
const SUCCESS_TTL_MS = 6 * 60 * 60_000;
const FAILURE_TTL_MS = 15 * 60_000;
const FORCE_FLOOR_MS = 60_000;
const MAX_ENTRIES = 64;

export type HarnessLatestRelease = { version?: string; checkedAt: number; error?: string };
export type HarnessUpdateChecker = {
    /** Newest published version; never throws, failures carry `error`. */
    latest(source: HarnessReleaseSource, options?: { force?: boolean }): Promise<HarnessLatestRelease>;
    forget(source: HarnessReleaseSource): void;
};

export function releaseSourceKey(source: HarnessReleaseSource): string {
    return source.kind === "npm"
        ? `npm:${source.package}@${source.distTag ?? "latest"}`
        : `page:${source.url}#${source.pattern}`;
}

/** Read at most `limit` bytes of a response body as text. */
async function boundedText(response: Response, limit: number): Promise<string> {
    if (!response.body)
        return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (size < limit) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            size += value.byteLength;
        }
    }
    finally {
        await reader.cancel().catch(() => undefined);
    }
    const bytes = new Uint8Array(Math.min(size, limit));
    let offset = 0;
    for (const chunk of chunks) {
        const part = chunk.subarray(0, bytes.byteLength - offset);
        bytes.set(part, offset);
        offset += part.byteLength;
        if (offset >= bytes.byteLength) break;
    }
    return new TextDecoder().decode(bytes);
}

export function createHarnessUpdateChecker(options: { fetch?: typeof globalThis.fetch; now?: () => number } = {}): HarnessUpdateChecker {
    // Resolved per call so a replaced global fetch (tests, instrumentation) applies.
    const fetcher: typeof globalThis.fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, init);
    const now = options.now ?? Date.now;
    const cache = new Map<string, HarnessLatestRelease>();
    const inflight = new Map<string, Promise<HarnessLatestRelease>>();
    // `forget` bumps a key's generation so a lookup started before it (for
    // example before an update ran) cannot re-cache the old answer.
    const generations = new Map<string, number>();

    const request = (url: string) => fetcher(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "follow",
        credentials: "omit",
        headers: { accept: "application/json, text/plain, */*" },
    });

    async function lookup(source: HarnessReleaseSource): Promise<string> {
        if (source.kind === "npm") {
            const tag = source.distTag ?? "latest";
            if (!NPM_PACKAGE.test(source.package) || !NPM_TAG.test(tag))
                throw new Error("invalid npm release source");
            const response = await request(`https://registry.npmjs.org/${source.package.replace("/", "%2f")}/${tag}`);
            if (!response.ok)
                throw new Error(`npm registry answered ${response.status}`);
            const manifest = JSON.parse(await boundedText(response, MAX_NPM_BYTES)) as { version?: unknown };
            if (typeof manifest.version !== "string" || !VERSION_TOKEN.test(manifest.version))
                throw new Error("npm manifest has no version");
            return manifest.version;
        }
        if (!/^https:\/\//i.test(source.url))
            throw new Error("release pages must use https");
        const response = await request(source.url);
        if (!response.ok)
            throw new Error(`release page answered ${response.status}`);
        const version = new RegExp(source.pattern).exec(await boundedText(response, MAX_PAGE_BYTES))?.[1];
        if (!version || !VERSION_TOKEN.test(version))
            throw new Error("release page names no version");
        return version;
    }

    function remember(key: string, entry: HarnessLatestRelease) {
        cache.delete(key);
        cache.set(key, entry);
        while (cache.size > MAX_ENTRIES)
            cache.delete(cache.keys().next().value!);
    }

    return {
        latest(source, { force = false } = {}) {
            const key = releaseSourceKey(source);
            const cached = cache.get(key);
            if (cached) {
                const age = now() - cached.checkedAt;
                const ttl = cached.error ? FAILURE_TTL_MS : SUCCESS_TTL_MS;
                if (age < (force ? Math.min(FORCE_FLOOR_MS, ttl) : ttl))
                    return Promise.resolve(cached);
            }
            const running = inflight.get(key);
            if (running)
                return running;
            const generation = generations.get(key) ?? 0;
            const pending: Promise<HarnessLatestRelease> = lookup(source).then(
                (version) => ({ version, checkedAt: now() }),
                (error: unknown) => ({ checkedAt: now(), error: error instanceof Error ? error.message : String(error) }),
            ).then((entry: HarnessLatestRelease) => {
                if ((generations.get(key) ?? 0) === generation)
                    remember(key, entry);
                return entry;
            }).finally(() => {
                if (inflight.get(key) === pending)
                    inflight.delete(key);
            });
            inflight.set(key, pending);
            return pending;
        },
        forget(source) {
            const key = releaseSourceKey(source);
            cache.delete(key);
            inflight.delete(key);
            generations.set(key, (generations.get(key) ?? 0) + 1);
            if (generations.size > MAX_ENTRIES * 4)
                generations.clear();
        },
    };
}

/** One harness's update status. `snapshot` is its cheap summary row; lookups
 *  only happen for an installed, local harness with a release source. */
export async function harnessUpdateStatus(input: {
    descriptor: HarnessDescriptor;
    snapshot?: HarnessSnapshot;
    remote: boolean;
    owner: boolean;
    checker: HarnessUpdateChecker;
    force?: boolean;
}): Promise<HarnessUpdateStatus> {
    const { descriptor, snapshot, remote } = input;
    const installedText = snapshot?.identity.version?.trim() || undefined;
    const installed = Boolean(snapshot?.availability.installed);
    const current = parseHarnessVersion(installedText);
    const base = {
        harnessId: descriptor.id,
        ...(installedText ? { installed: installedText } : {}),
        ...(current ? { current: current.text } : {}),
        available: false,
        canUpdate: Boolean(descriptor.updateCommand?.length) && input.owner && !remote && installed,
    };
    if (remote)
        return { ...base, reason: "remote" };
    if (descriptor.bundled)
        return { ...base, canUpdate: false, reason: "bundled" };
    if (!installed)
        return { ...base, reason: "not-installed" };
    if (!descriptor.releaseSource)
        return { ...base, reason: "unsupported" };
    const release = await input.checker.latest(descriptor.releaseSource, { force: input.force });
    if (release.error || !release.version)
        return { ...base, checkedAt: release.checkedAt, reason: "unavailable" };
    const latest = parseHarnessVersion(release.version);
    const answer = { ...base, latest: latest?.text ?? release.version, checkedAt: release.checkedAt };
    if (!current || !latest)
        return { ...answer, reason: "unparsed" };
    return { ...answer, available: compareHarnessVersions(latest, current) > 0 };
}
