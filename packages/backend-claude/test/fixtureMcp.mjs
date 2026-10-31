import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (request.id === undefined) continue;
  let result = {};
  if (request.method === "initialize") {
    result = {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "polyth-claude-test", version: "1.0.0" },
    };
  }
  if (request.method === "tools/list") {
    result = { tools: [{ name: "fixture_read", description: "Deterministic test tool", inputSchema: { type: "object" } }] };
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
