export const PROJECT_ICON_LIBRARIES = [
  { id: "hugeicons", label: "Hugeicons" },
  { id: "mingcute", label: "MingCute" },
  { id: "ph", label: "Phosphor" },
  { id: "mynaui", label: "Myna" },
  { id: "tabler", label: "Tabler" },
] as const;

export type ProjectIconLibrary = typeof PROJECT_ICON_LIBRARIES[number]["id"];

export type ProjectIconCategory =
  | "suggested"
  | "recent"
  | "favorites"
  | "tech"
  | "work"
  | "creative"
  | "development"
  | "security"
  | "media"
  | "home"
  | "ai"
  | "data"
  | "cloud"
  | "science"
  | "tools";

export const ICONIFY_PROJECT_ICON_PREFIX = "iconify:";
export const PROJECT_ICON_PREFIXES = PROJECT_ICON_LIBRARIES.map(({ id }) => id).join(",");

const ICONIFY_METADATA_ID = "polyth-iconify";
const ICONIFY_DATA_PREFIX = "data:image/svg+xml;charset=utf-8,";

const LIBRARY_LABELS = new Map<string, string>(
  PROJECT_ICON_LIBRARIES.map(({ id, label }) => [id, label]),
);

const USEFUL_ICON_HINTS = [
  "search",
  "folder",
  "code",
  "terminal",
  "database",
  "server",
  "cloud",
  "shield",
  "lock",
  "brain",
  "bot",
  "robot",
  "spark",
  "star",
  "book",
  "home",
  "camera",
  "music",
  "game",
  "rocket",
  "briefcase",
] as const;

const TITLE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ai: ["brain", "robot", "sparkles", "magic"],
  api: ["api", "code", "server", "network", "plug"],
  app: ["app", "window", "layout", "grid", "package"],
  case: ["folder", "file", "archive", "briefcase"],
  chat: ["chat", "message", "conversation"],
  cloud: ["cloud", "server", "network"],
  code: ["code", "terminal", "command", "git"],
  data: ["database", "table", "chart", "storage"],
  database: ["database", "storage", "server", "table"],
  dev: ["code", "terminal", "git", "branch"],
  game: ["game", "controller", "joystick"],
  home: ["home", "house"],
  media: ["image", "camera", "video", "music", "play"],
  music: ["music", "note", "headphones", "audio"],
  project: ["folder", "briefcase", "package", "layers"],
  search: ["search", "find", "scan", "target", "radar"],
  security: ["shield", "lock", "key", "fingerprint"],
  seek: ["search", "find", "scan", "target", "radar"],
  server: ["server", "database", "cloud", "rack"],
  work: ["briefcase", "folder", "task", "check"],
};

const CATEGORY_QUERIES: Readonly<Record<Exclude<ProjectIconCategory, "suggested" | "recent" | "favorites">, readonly string[]>> = {
  tech: ["technology", "device", "cpu"],
  work: ["briefcase", "work", "task"],
  creative: ["palette", "sparkles", "pen"],
  development: ["code", "terminal", "git"],
  security: ["shield", "lock", "fingerprint"],
  media: ["media", "image", "video"],
  home: ["home", "house", "smart home"],
  ai: ["brain", "robot", "sparkles"],
  data: ["database", "chart", "table"],
  cloud: ["cloud", "server", "network"],
  science: ["flask", "atom", "microscope"],
  tools: ["tools", "wrench", "settings"],
};

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function normalize(value: string): string {
  return decodeName(value)
    .replace(ICONIFY_PROJECT_ICON_PREFIX, "")
    .replace(/^[a-z0-9-]+:/i, "")
    .replace(/\.svg$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function titleSearchTerms(projectTitle: string): string[] {
  const tokens = normalize(projectTitle).split(" ").filter(Boolean);
  const terms: string[] = [];
  for (const token of tokens.toReversed()) {
    for (const alias of TITLE_ALIASES[token] ?? []) {
      if (!terms.includes(alias)) terms.push(alias);
    }
    if (token.length > 2 && !terms.includes(token)) terms.push(token);
  }
  return terms.length > 0 ? terms : ["project", "folder", "sparkles"];
}

export function projectIconLabel(name: string): string {
  return normalize(name);
}

export function filterProjectIcons(iconNames: readonly string[], query: string): string[] {
  const tokens = normalize(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return [...iconNames];
  return iconNames.filter((name) => {
    const label = normalize(name);
    return tokens.every((token) => label.includes(token));
  });
}

export function rankSuggestedProjectIcons(
  iconNames: readonly string[],
  projectTitle: string,
  selectedIconName = "",
): string[] {
  const titleTokens = normalize(projectTitle).split(" ").filter(Boolean);
  const selected = normalize(selectedIconName);
  const expanded = new Set<string>();

  for (const token of titleTokens) {
    expanded.add(token);
    for (const alias of TITLE_ALIASES[token] ?? []) expanded.add(alias);
  }

  return iconNames
    .map((name, index) => {
      const label = normalize(name);
      let score = 0;

      if (selected && label === selected) score += 1_000;
      for (const token of titleTokens) {
        if (label === token) score += 180;
        else if (label.includes(token)) score += 100;
      }
      for (const hint of expanded) {
        if (titleTokens.includes(hint)) continue;
        if (label === hint) score += 120;
        else if (label.includes(hint)) score += 60;
      }

      const usefulIndex = USEFUL_ICON_HINTS.findIndex((hint) => label.includes(hint));
      if (usefulIndex >= 0) score += Math.max(1, USEFUL_ICON_HINTS.length - usefulIndex);

      return { name, index, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ name }) => name);
}

export function projectIconCategoryQuery(
  category: ProjectIconCategory,
  projectTitle: string,
  variation = 0,
): string {
  if (category === "suggested") {
    const terms = titleSearchTerms(projectTitle);
    return terms[Math.abs(variation) % terms.length] ?? "project";
  }
  if (category === "recent" || category === "favorites") return "";
  const terms = CATEGORY_QUERIES[category];
  return terms[Math.abs(variation) % terms.length] ?? terms[0] ?? "project";
}

export function updateRecentProjectIcons(
  existing: readonly string[],
  iconName: string,
  limit = 12,
): string[] {
  const normalizedName = iconName.trim();
  if (!normalizedName || limit <= 0) return existing.slice(0, Math.max(0, limit));
  return [normalizedName, ...existing.filter((name) => name !== normalizedName)].slice(0, limit);
}

export function toggleFavoriteProjectIcon(existing: readonly string[], iconName: string): string[] {
  const normalizedName = iconName.trim();
  if (!normalizedName) return [...existing];
  return existing.includes(normalizedName)
    ? existing.filter((name) => name !== normalizedName)
    : [normalizedName, ...existing];
}

export function iconifyProjectIconName(value: string | undefined): string | null {
  if (!value?.startsWith(ICONIFY_PROJECT_ICON_PREFIX)) return null;
  const name = value.slice(ICONIFY_PROJECT_ICON_PREFIX.length);
  return isSupportedIconifyName(name) ? name : null;
}

export function iconifyProjectIconValue(name: string): string {
  return isSupportedIconifyName(name) ? `${ICONIFY_PROJECT_ICON_PREFIX}${name}` : "";
}

export function isSupportedIconifyName(name: string): boolean {
  const separator = name.indexOf(":");
  if (separator <= 0 || separator === name.length - 1) return false;
  const prefix = name.slice(0, separator);
  const iconName = name.slice(separator + 1);
  return LIBRARY_LABELS.has(prefix) && /^[a-z0-9][a-z0-9._-]*$/i.test(iconName);
}

export function projectIconProviderLabel(value: string): string {
  const name = value.startsWith(ICONIFY_PROJECT_ICON_PREFIX)
    ? value.slice(ICONIFY_PROJECT_ICON_PREFIX.length)
    : value;
  const separator = name.indexOf(":");
  return separator > 0 ? LIBRARY_LABELS.get(name.slice(0, separator)) ?? "Iconify" : "Bundled";
}

export function iconifySvgUrl(name: string): string {
  if (!isSupportedIconifyName(name)) return "";
  const separator = name.indexOf(":");
  const prefix = name.slice(0, separator);
  const iconName = name.slice(separator + 1);
  return `https://api.iconify.design/${encodeURIComponent(prefix)}/${encodeURIComponent(iconName)}.svg`;
}

export function embeddedIconifyName(value: string | undefined): string | null {
  if (!value?.startsWith(ICONIFY_DATA_PREFIX)) return null;
  try {
    const svg = decodeURIComponent(value.slice(ICONIFY_DATA_PREFIX.length));
    const match = svg.match(/<metadata\s+id=["']polyth-iconify["']>([^<]+)<\/metadata>/i);
    return match?.[1] && isSupportedIconifyName(match[1]) ? match[1] : null;
  } catch {
    return null;
  }
}

export function storedProjectIconSelection(value: string | undefined): string {
  const remoteName = embeddedIconifyName(value);
  return remoteName ? iconifyProjectIconValue(remoteName) : value ?? "";
}

export function inlineIconifySvgDataUrl(name: string, svg: string, color: string): string {
  if (!isSupportedIconifyName(name)) return "";
  const ink = /^#[0-9a-f]{6}$/i.test(color) ? color.toLocaleLowerCase() : "#000000";
  let clean = svg
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!doctype[\s\S]*?>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<metadata\s+id=["']polyth-iconify["']>[\s\S]*?<\/metadata>/gi, "")
    .trim();
  if (!/^<svg\b/i.test(clean)) return "";
  clean = clean.replace(/currentColor/gi, ink);
  const openingEnd = clean.indexOf(">");
  if (openingEnd < 0) return "";
  const metadata = `<metadata id="${ICONIFY_METADATA_ID}">${name}</metadata>`;
  clean = `${clean.slice(0, openingEnd + 1)}${metadata}${clean.slice(openingEnd + 1)}`;
  return `${ICONIFY_DATA_PREFIX}${encodeURIComponent(clean)}`;
}

export function projectIconMaskUrl(value: string): string {
  const remoteName = iconifyProjectIconName(value) ?? embeddedIconifyName(value);
  if (remoteName) return iconifySvgUrl(remoteName);
  return value.startsWith("/assets/project-icons/") ? value : "";
}

export function iconifySearchUrl(query: string, library: ProjectIconLibrary | "all" = "all", limit = 64): string {
  const params = new URLSearchParams({
    query: query.trim() || "project",
    limit: String(Math.max(32, Math.min(999, limit))),
  });
  if (library === "all") params.set("prefixes", PROJECT_ICON_PREFIXES);
  else params.set("prefix", library);
  return `https://api.iconify.design/search?${params.toString()}`;
}

export function filterSupportedIconifyNames(names: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of names) {
    if (typeof value !== "string" || !isSupportedIconifyName(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
