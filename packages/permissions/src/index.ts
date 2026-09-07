// Monotonic, fail-closed permission rules engine.
// Rules persist to <dataDir>/permissions.json. "always" replies become allow
// rules whose scope is explicit (WP15): user-wide, one project, or one session.
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteSync } from "@polyth/plugins";

export type RuleAction = "allow" | "deny" | "ask";
export interface PermissionRule {
  permission: string;       // e.g. "bash", "edit", "webfetch"
  pattern: string;          // exact string or prefix glob "npm *"
  action: RuleAction;
  scope: "user" | "project" | "session";
  projectId?: string;
  sessionId?: string;
}

export interface PermissionService {
  evaluate(permission: string, patterns: string[], projectId?: string, sessionId?: string): RuleAction;
  addRule(rule: PermissionRule): void;
  rules(): PermissionRule[];
}

const matches = (rulePattern: string, value: string): boolean => {
  if (rulePattern === "*") return true;
  if (rulePattern.endsWith("*")) return value.startsWith(rulePattern.slice(0, -1));
  return rulePattern === value;
};

export function createPermissionService(dataDir: string): PermissionService {
  const file = `${dataDir}/permissions.json`;
  let ruleList: PermissionRule[] = [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as PermissionRule[];
    // Pre-WP15 records lack a session scope; anything unrecognized falls back
    // to the old user scope so existing behavior is preserved.
    ruleList = parsed.map((r) => ({ ...r, scope: r.scope === "project" || r.scope === "session" ? r.scope : "user" }));
  } catch { /* first run */ }

  const persist = () => {
    mkdirSync(dirname(file), { recursive: true });
    atomicWriteSync(file, JSON.stringify(ruleList, null, 2));
  };

  return {
    evaluate(permission, patterns, projectId, sessionId) {
      // fail closed: default ask. deny wins over allow (monotonic).
      let verdict: RuleAction = "ask";
      for (const p of patterns.length ? patterns : ["*"]) {
        for (const r of ruleList) {
          if (r.permission !== permission && r.permission !== "*") continue;
          if (r.scope === "project" && r.projectId !== projectId) continue;
          if (r.scope === "session" && r.sessionId !== sessionId) continue;
          if (!matches(r.pattern, p)) continue;
          if (r.action === "deny") return "deny";
          verdict = "allow";
        }
      }
      return verdict;
    },
    addRule(rule) {
      ruleList = ruleList.filter(
        (x) => !(
          x.permission === rule.permission && x.pattern === rule.pattern &&
          x.scope === rule.scope && x.projectId === rule.projectId && x.sessionId === rule.sessionId
        ),
      );
      ruleList.push(rule);
      persist();
    },
    rules: () => [...ruleList],
  };
}

// ---- F18: per-session auto-accept policy -------------------------------------

/** "inherit" (default) defers to the nearest ancestor with an explicit
 *  setting; "off" is a child's explicit opt-out from an inherited "on". */
export type AutoAcceptSetting = "on" | "off" | "inherit";

/** Pure nearest-parent policy resolution (F18). Walks the parent chain until
 *  an explicit "on"/"off" appears; the root default is OFF — auto-accept is
 *  never a global default. Cycle- and depth-guarded. */
export function resolveAutoAccept(
  sessionId: string,
  settingOf: (id: string) => AutoAcceptSetting,
  parentOf: (id: string) => string | undefined,
): boolean {
  const seen = new Set<string>();
  let id: string | undefined = sessionId;
  while (id && !seen.has(id) && seen.size < 64) {
    seen.add(id);
    const setting = settingOf(id);
    if (setting === "on") return true;
    if (setting === "off") return false;
    id = parentOf(id);
  }
  return false;
}

export interface AutoAcceptStore {
  get(sessionId: string): AutoAcceptSetting;
  /** "inherit" removes the record — only explicit choices persist. */
  set(sessionId: string, setting: AutoAcceptSetting): void;
}

/** Persistent explicit-settings map (<file> holds only "on"/"off" entries). */
export function createAutoAcceptStore(file: string): AutoAcceptStore {
  const settings = new Map<string, "on" | "off">();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      if (v === "on" || v === "off") settings.set(k, v);
    }
  } catch { /* first run */ }

  const persist = () => {
    mkdirSync(dirname(file), { recursive: true });
    atomicWriteSync(file, JSON.stringify(Object.fromEntries(settings), null, 2));
  };

  return {
    get: (sessionId) => settings.get(sessionId) ?? "inherit",
    set(sessionId, setting) {
      if (setting === "inherit") {
        if (!settings.delete(sessionId)) return;
      } else {
        if (settings.get(sessionId) === setting) return;
        settings.set(sessionId, setting);
      }
      persist();
    },
  };
}
