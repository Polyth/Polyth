// The environment Polyth starts `vibe-acp` with.
//
// `vibe-acp` takes no flags beyond `--setup`, but Vibe reads every `VIBE_*`
// variable as a configuration layer above the person's own `config.toml`
// (pydantic-settings, `env_nested_delimiter="__"`; verified against 3.1.5).
// That layer is how Polyth switches off what it owns itself without editing
// the person's Vibe configuration:
//
// - subagents (`tools.agents.*` / `tools.subagent.*` inside `run_typescript`):
//   delegation belongs to Polyth;
// - background processes (`tools.process.*`): a process that finishes after
//   the turn wakes the agent into a turn Polyth never admitted;
// - `cron` and the goal tools: both start turns of their own between prompts;
// - the default approval policy, set to `ask`, so every tool call Vibe does
//   not already consider safe reaches Polyth's own approval policy instead of
//   a personal `auto-approve` default;
// - Vibe's commit signature, because no agent credits itself in a commit;
// - its update checks: Polyth offers updates in Settings;
// - its title request: Polyth names the chat itself.
import type { ResolvedHarnessAccount } from "@polyth/harness-runtime/accounts";

/** Tools Polyth removes from every Vibe session (Vibe's `disabled_tools`). */
export const VIBE_POLYTH_DISABLED_TOOLS = ["cron", "create_goal", "update_goal", "get_goal"] as const;

export const VIBE_POLYTH_SETTINGS: Readonly<Record<string, string>> = {
    VIBE_ENABLE_SUBAGENTS: "false",
    VIBE_ENABLE_BACKGROUND_PROCESSES: "false",
    VIBE_DEFAULT_APPROVAL_POLICY: "ask",
    VIBE_INCLUDE_COMMIT_SIGNATURE: "false",
    VIBE_ENABLE_UPDATE_CHECKS: "false",
    VIBE_ENABLE_AUTO_UPDATE: "false",
    // Polyth names the chat; Vibe's title request would be one more model
    // call per session on the person's quota.
    VIBE_SESSION_LOGGING__GENERATE_TITLES: "false",
};

/** The API key variable of Vibe's built-in `mistral` provider. */
export const MISTRAL_API_KEY_ENV = "MISTRAL_API_KEY";

/** A person's own `VIBE_DISABLED_TOOLS` is kept; Polyth's tools are added. */
const disabledTools = (own: string | undefined): string => {
    let tools: string[] = [];
    if (own?.trim()) {
        try {
            const parsed: unknown = JSON.parse(own);
            if (Array.isArray(parsed)) tools = parsed.filter((tool): tool is string => typeof tool === "string");
        } catch {
            // Vibe ignores an unparseable value with a warning; so does Polyth.
        }
    }
    return JSON.stringify([...new Set([...tools, ...VIBE_POLYTH_DISABLED_TOOLS])]);
};

/**
 * The child environment of one Vibe login. `VIBE_HOME` holds a login's
 * `.env` (where `vibe --setup` keeps the API key), `config.toml`, skills and
 * native sessions. An added account must not inherit the server's own
 * `MISTRAL_API_KEY`: the launch environment wins over the account's `.env`,
 * so the account would silently run on the default key.
 */
export function vibeChildEnv(base: NodeJS.ProcessEnv, account?: ResolvedHarnessAccount): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, ...VIBE_POLYTH_SETTINGS, VIBE_DISABLED_TOOLS: disabledTools(base.VIBE_DISABLED_TOOLS) };
    if (account) {
        delete env[MISTRAL_API_KEY_ENV];
        env.VIBE_HOME = account.dir;
    }
    return env;
}
