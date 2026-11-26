// The tool names Vibe's calls are reported under.
//
// Every `tool_call` / `tool_call_update` names its tool in
// `_meta.tool_name` (verified against 3.1.5): builtins by their own name
// (`bash`, `write_file`, `todo`, `search_tool_functions`), MCP tools as
// `mcp_<server>.<tool>`, where the server name has every character other
// than a letter, digit or `_` replaced by `_` (Polyth's
// `polyth-agent-tools` arrives as `mcp_polyth_agent_tools.polyth_todo`).
// MCP tools are reached only through Vibe's `run_typescript` code mode, but
// each call is still announced and approved on its own.
//
// Polyth reports MCP tools as `mcp__<server>__<tool>`. Its own server's name
// is restored, so every consumer recognizes Polyth's tools.
const POLYTH_SERVER = "polyth-agent-tools";
const POLYTH_GROUP = POLYTH_SERVER.replace(/[^A-Za-z0-9_]/g, "_");
const MCP_CALL = /^mcp_([A-Za-z0-9_]+)\.([A-Za-z0-9_.-]+)$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;

export function vibeToolName(name: string): string {
    const mcp = MCP_CALL.exec(name);
    if (!mcp) return name;
    const server = mcp[1] === POLYTH_GROUP ? POLYTH_SERVER : mcp[1]!;
    return `mcp__${server}__${mcp[2]}`;
}

/** `nativeToolName` hook: the tool named in an update's `_meta`. */
export function vibeNativeToolName(update: Record<string, unknown>): string | undefined {
    const meta = update._meta;
    const name = meta && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as Record<string, unknown>).tool_name
        : undefined;
    return typeof name === "string" && NAME.test(name) ? vibeToolName(name) : undefined;
}
