import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpaceStorage } from "@polyth/contracts";
import { normalizeSymbol } from "./service.ts";

export interface MarketWatchlist {
  id: string;
  name: string;
  symbols: string[];
}

export interface MarketWatchlists {
  version: 1;
  activeId: string;
  items: MarketWatchlist[];
}

const WATCHLIST_ID = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const MAX_LISTS = 12;
const MAX_SYMBOLS = 100;

export const DEFAULT_WATCHLISTS: MarketWatchlists = {
  version: 1,
  activeId: "default",
  items: [{ id: "default", name: "Watchlist", symbols: ["SPY", "QQQ"] }],
};

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: "invalid-input" });
}

export function parseWatchlists(value: unknown): MarketWatchlists {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("watchlists must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) fail("unsupported watchlist version");
  if (typeof raw.activeId !== "string" || !WATCHLIST_ID.test(raw.activeId)) fail("active watchlist id is invalid");
  if (!Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > MAX_LISTS) {
    fail(`watchlists must contain 1-${MAX_LISTS} lists`);
  }

  const ids = new Set<string>();
  const items = raw.items.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("each watchlist must be an object");
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || !WATCHLIST_ID.test(item.id)) fail("watchlist id is invalid");
    if (ids.has(item.id)) fail(`duplicate watchlist id: ${item.id}`);
    ids.add(item.id);
    if (typeof item.name !== "string" || !item.name.trim() || item.name.trim().length > 64) {
      fail("watchlist name must be 1-64 characters");
    }
    if (!Array.isArray(item.symbols) || item.symbols.length > MAX_SYMBOLS) {
      fail(`a watchlist may contain at most ${MAX_SYMBOLS} symbols`);
    }
    const symbols: string[] = [];
    const seen = new Set<string>();
    for (const candidate of item.symbols) {
      if (typeof candidate !== "string") fail("watchlist symbols must be strings");
      const symbol = normalizeSymbol(candidate);
      if (!seen.has(symbol)) {
        seen.add(symbol);
        symbols.push(symbol);
      }
    }
    return { id: item.id, name: item.name.trim(), symbols };
  });

  if (!ids.has(raw.activeId)) fail("active watchlist does not exist");
  return { version: 1, activeId: raw.activeId, items };
}

export async function loadWatchlists(storage: SpaceStorage): Promise<MarketWatchlists> {
  const file = join(storage.packageDir("markets"), "watchlists.json");
  try {
    return parseWatchlists(JSON.parse(await readFile(file, "utf8")));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_WATCHLISTS);
    throw cause;
  }
}

export async function saveWatchlists(storage: SpaceStorage, value: unknown): Promise<MarketWatchlists> {
  const document = parseWatchlists(value);
  const dir = storage.packageDir("markets");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "watchlists.json");
  const temporary = join(dir, `.watchlists.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return document;
}
