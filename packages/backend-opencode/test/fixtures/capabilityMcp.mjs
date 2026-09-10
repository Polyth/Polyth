import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "polyth-probe", version: "1" } }
    : request.method === "tools/list"
      ? { tools: [{ name: "probe", description: "Return deterministic probe", inputSchema: { type: "object", properties: {} } }] }
      : request.method === "tools/call" ? { content: [{ type: "text", text: "polyth-probe-ok" }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
