// Stdio MCP servers for a Copilot ACP launch.
//
// Copilot's ACP server accepts only HTTP and SSE servers on `session/new`
// (1.0.109 logs `Rejecting non-http/sse MCP server … from client`), and the
// Polyth agent tools are a stdio server. Its launch option
// `--additional-mcp-config @<file>` does take stdio servers, with their
// environment, for every session of that process — and a Polyth runtime is
// one process per chat. The file holds the servers' secrets, so it is
// private to the owner and removed with the runtime; nothing secret is put
// on the command line.
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AcpStdioMcpServer } from "@polyth/backend-acp";

/** Copilot's `mcp-config.json` shape for the given servers. */
export function copilotMcpConfig(servers: readonly AcpStdioMcpServer[]): { mcpServers: Record<string, unknown> } {
    return {
        mcpServers: Object.fromEntries(servers.map((server) => [server.name, {
            type: "stdio",
            command: server.command,
            args: server.args,
            env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
            tools: ["*"],
        }])),
    };
}

/** Write the launch file and return the arguments that load it. */
export async function writeCopilotLaunchMcp(input: { servers: AcpStdioMcpServer[]; file: string }): Promise<string[]> {
    if (!input.servers.length) {
        await rm(input.file, { force: true });
        return [];
    }
    await mkdir(dirname(input.file), { recursive: true });
    await writeFile(input.file, JSON.stringify(copilotMcpConfig(input.servers)), { mode: 0o600 });
    // `mode` applies only to a new file; an earlier launch may have left one.
    await chmod(input.file, 0o600);
    return [`--additional-mcp-config=@${input.file}`];
}
