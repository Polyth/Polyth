// Mistral Vibe names one model by several ids. Its ACP `model` select offers
// each model under its config alias: the built-in defaults
// (`mistral-medium-3.5`, `mistral-large-4-0`) until the account's Mistral
// catalog has loaded, then the catalog ids (`mistral-medium-latest`, …). Vibe
// resolves every one of them itself (`session/set_config_option` accepts a
// catalog alias), so a selection saved under either name is still that model.
//
// The catalog's aliases are not on the ACP wire. Vibe 3.x caches the catalog it
// fetched in `$VIBE_HOME/model_catalog_cache.json`:
//   { "<account key>": { "stored_at_timestamp": n, "payload": { "models": [
//       { "id": "mistral-medium-latest", "aliases": ["mistral-medium-3.5", …] } ] } } }
// That file is read here with Vibe's own alias rules (`_model_aliases.py`): an
// alias that is itself a model id, or that two models claim, names nothing.
// A missing or unreadable file only means no aliases: ids are kept verbatim.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AcpModelIdCodec } from "@polyth/backend-acp";

const CATALOG_FILE = "model_catalog_cache.json";
const MAX_CATALOG_BYTES = 1024 * 1024;

export interface VibeAliasIndex {
    /** Alias → the model id it names. */
    targets: ReadonlyMap<string, string>;
}

const EMPTY: VibeAliasIndex = { targets: new Map() };

const record = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The alias index of the newest catalog in a `model_catalog_cache.json` body. */
export const parseVibeModelCatalog = (text: string): VibeAliasIndex => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return EMPTY;
    }
    // One entry per account key; the newest is the one Vibe fetched last.
    let newest: { at: number; models: unknown[] } | undefined;
    for (const entry of Object.values(record(parsed) ?? {})) {
        const row = record(entry);
        const models = record(row?.payload)?.models;
        if (!Array.isArray(models)) continue;
        const at = typeof row?.stored_at_timestamp === "number" ? row.stored_at_timestamp : 0;
        if (!newest || at > newest.at) newest = { at, models };
    }
    if (!newest) return EMPTY;
    const ids = new Set<string>();
    const claims = new Map<string, Set<string>>();
    for (const model of newest.models) {
        const row = record(model);
        const id = typeof row?.id === "string" && row.id.trim() ? row.id : undefined;
        if (!id) continue;
        ids.add(id);
        for (const alias of Array.isArray(row!.aliases) ? row!.aliases : []) {
            if (typeof alias !== "string" || !alias.trim() || alias === id) continue;
            claims.set(alias, (claims.get(alias) ?? new Set()).add(id));
        }
    }
    const targets = new Map<string, string>();
    for (const [alias, owners] of claims) {
        if (ids.has(alias) || owners.size !== 1) continue;
        targets.set(alias, [...owners][0]!);
    }
    return { targets };
};

/**
 * Polyth's model ids for one Vibe home: a model offered under an alias (the
 * built-in defaults before the catalog loads) gets its catalog id, and every
 * row publishes the aliases Vibe resolves to it. The file is re-read only when
 * it changes.
 */
export const createVibeModelIdCodec = (home: () => string): AcpModelIdCodec => {
    let read: { path: string; mtimeMs: number; size: number; index: VibeAliasIndex } | undefined;
    const index = (): VibeAliasIndex => {
        const path = join(home(), CATALOG_FILE);
        try {
            const stat = statSync(path);
            if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) return EMPTY;
            if (read && read.path === path && read.mtimeMs === stat.mtimeMs && read.size === stat.size) return read.index;
            const parsed = parseVibeModelCatalog(readFileSync(path, "utf8"));
            read = { path, mtimeMs: stat.mtimeMs, size: stat.size, index: parsed };
            return parsed;
        } catch {
            return EMPTY;
        }
    };
    return {
        canonical: (value) => index().targets.get(value) ?? value,
        aliases(value) {
            const names = [...index().targets].filter(([, target]) => target === value).map(([alias]) => alias);
            return names.length ? names : undefined;
        },
    };
};
