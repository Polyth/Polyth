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
  ai: ["brain", "bot", "robot", "spark", "magic"],
  api: ["code", "braces", "server", "network", "plug"],
  app: ["window", "layout", "grid", "package"],
  case: ["folder", "file", "archive", "briefcase"],
  chat: ["chat", "message", "bubble", "conversation"],
  cloud: ["cloud", "server", "network"],
  code: ["code", "terminal", "command", "braces", "git"],
  data: ["database", "table", "chart", "storage"],
  database: ["database", "storage", "server", "table"],
  dev: ["code", "terminal", "command", "git", "branch"],
  game: ["game", "controller", "joystick"],
  home: ["home", "house"],
  media: ["image", "camera", "video", "music", "play"],
  music: ["music", "note", "headphone", "audio"],
  project: ["folder", "briefcase", "package", "layers"],
  search: ["search", "find", "scan", "target", "radar"],
  security: ["shield", "lock", "key", "fingerprint"],
  seek: ["search", "find", "scan", "target", "radar"],
  server: ["server", "database", "cloud", "rack"],
  work: ["briefcase", "folder", "task", "check"],
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
    .replace(/\.svg$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
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

export function updateRecentProjectIcons(
  existing: readonly string[],
  iconName: string,
  limit = 12,
): string[] {
  const normalizedName = iconName.trim();
  if (!normalizedName || limit <= 0) return existing.slice(0, Math.max(0, limit));
  return [normalizedName, ...existing.filter((name) => name !== normalizedName)].slice(0, limit);
}
