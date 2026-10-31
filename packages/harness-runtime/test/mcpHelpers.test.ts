import assert from "node:assert/strict";
import test from "node:test";
import {
  describeNativeProvision,
  filterTools,
  formatArgsJson,
  inspectionStatusLabel,
  nativeMcpStatuses,
  parseArgsJson,
  parseMcpServersJson,
  RESERVED_MCP_NAME,
  sanitizeImportPreview,
  toImportRequestBody,
  validateImportBatch,
  validateMcpName,
} from "../widgets/mcpHelpers.ts";

test("JSON argument arrays preserve spaces", () => {
  const parsed = parseArgsJson('["--config","path with spaces","keep"]');
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.args, ["--config", "path with spaces", "keep"]);
  assert.equal(formatArgsJson(parsed.args), '["--config","path with spaces","keep"]');
  assert.equal(parseArgsJson("").args.length, 0);
  assert.match(parseArgsJson("[1]").error ?? "", /JSON array of strings/);
});

test("reserved polyth-agent-tools names are rejected", () => {
  assert.match(validateMcpName(RESERVED_MCP_NAME) ?? "", /reserved/);
  assert.equal(validateMcpName("docs-server"), undefined);
});

test("parses mcpServers, Codex mcp_servers, and OpenCode mcp maps", () => {
  const claude = parseMcpServersJson(JSON.stringify({
    mcpServers: {
      airtable: { command: "npx", args: ["-y", "pkg"], env: { AIRTABLE_API_KEY: "pat-secret" } },
    },
  }));
  assert.deepEqual(claude.errors, []);
  assert.equal(claude.entries[0]?.name, "airtable");
  assert.deepEqual(claude.entries[0]?.secrets, { AIRTABLE_API_KEY: "pat-secret" });

  const codex = parseMcpServersJson(JSON.stringify({
    mcp_servers: {
      docs: { url: "https://mcp.example.com/mcp", http_headers: { Authorization: "Bearer x" } },
    },
  }));
  assert.deepEqual(codex.errors, []);
  assert.equal(codex.entries[0]?.transport.kind, "http");
  assert.deepEqual(codex.entries[0]?.secrets, { Authorization: "Bearer x" });

  const opencode = parseMcpServersJson(JSON.stringify({
    mcp: {
      "local-x": { type: "local", command: ["bun", "run", "tool with spaces"], environment: { K: "v" }, enabled: false },
    },
  }));
  assert.deepEqual(opencode.errors, []);
  assert.deepEqual(opencode.entries[0]?.transport, {
    kind: "stdio",
    command: "bun",
    args: ["run", "tool with spaces"],
    envKeys: ["K"],
  });
  assert.equal(opencode.entries[0]?.enabled, false);
  const v2 = parseMcpServersJson(JSON.stringify({ mcp: { servers: { docs: { type: "local", command: ["node", "server.mjs"], disabled: true } }, codemode: {} } }));
  assert.deepEqual(v2.errors, []);
  assert.equal(v2.entries[0]?.enabled, false);
});

test("import preview never includes secret values", () => {
  const parsed = parseMcpServersJson(JSON.stringify({
    mcpServers: {
      airtable: { command: "npx", args: ["srv"], env: { AIRTABLE_API_KEY: "pat-secret" } },
    },
  }));
  const preview = sanitizeImportPreview(parsed.entries[0]!, new Set());
  const serialized = JSON.stringify(preview);
  assert.equal(serialized.includes("pat-secret"), false);
  assert.deepEqual(preview.secretKeys, ["AIRTABLE_API_KEY"]);
  assert.equal("secrets" in preview, false);
});

test("import rejects malformed fields without silently dropping entries or echoing pasted values", () => {
  for (const raw of [{ command: "node", args: [42] }, { command: ["node", 42] }, { command: "node", env: { SECRET: 42 } }, { url: "https://x.test", headers: [] }, { command: "node", enabled: "false" }]) {
    const result = parseMcpServersJson(JSON.stringify({ mcpServers: { invalid: raw } }));
    assert.equal(result.entries.length, 0);
    assert.equal(result.errors.length, 1);
  }
  assert.doesNotMatch(JSON.stringify(parseMcpServersJson('{"SECRET":"synthetic-secret" bad}')), /synthetic-secret/);
});

test("import validation flags duplicates, reserved names, and malformed JSON", () => {
  assert.match(parseMcpServersJson("{oops").errors[0] ?? "", /not valid JSON/);
  const reserved = parseMcpServersJson(JSON.stringify({
    mcpServers: { [RESERVED_MCP_NAME]: { command: "node" } },
  }));
  assert.equal(reserved.entries.length, 0);
  assert.match(reserved.errors[0] ?? "", /reserved/);
  const batch = validateImportBatch(
    [{ name: "docs", transport: { kind: "http", url: "https://x.test/mcp", headersSecretRefs: [] }, enabled: true }],
    new Set(["docs"]),
  );
  assert.match(batch[0] ?? "", /already exists/);
});

test("import request body keeps secrets for the protected form POST only", () => {
  const body = toImportRequestBody([{
    name: "docs",
    transport: { kind: "http", url: "https://x.test/mcp", headersSecretRefs: ["Authorization"] },
    secrets: { Authorization: "Bearer hidden" },
    enabled: false,
  }]);
  assert.equal(body.servers[0]?.enabled, false);
  assert.equal(body.servers[0]?.secrets?.Authorization, "Bearer hidden");
});

test("inspection labels stay honest for an unchecked starting server", () => {
  assert.equal(inspectionStatusLabel({ enabled: true, status: "starting" }), "Not checked yet");
  assert.equal(inspectionStatusLabel({
    enabled: true,
    status: "connected",
    inspection: { ok: true, message: "ok", checkedAt: 1, tools: [] },
  }), "Checked");
});

test("tool search matches name and description", () => {
  const tools = [
    { name: "search", description: "Find files", inputSchema: {} },
    { name: "write", inputSchema: {} },
  ];
  assert.equal(filterTools(tools, "find").length, 1);
  assert.equal(filterTools(tools, "WRITE")[0]?.name, "write");
});

test("native provision copy never claims invocation is proven", () => {
  assert.match(describeNativeProvision("applied"), /not proven/);
  assert.match(describeNativeProvision("unverifiable"), /not proven/);
  const rows = nativeMcpStatuses([{
    harnessId: "codex",
    desiredRevision: "1",
    records: [{
      capabilityId: "mcp.docs",
      kind: "mcp-server",
      owner: "polyth",
      desiredRevision: "1",
      mode: "mcp",
      status: "applied",
      evidence: { stage: "invocable", source: "native" },
    }],
  }]);
  assert.match(rows[0]?.label ?? "", /not proven/);
  assert.equal(JSON.stringify(rows).includes("invocable"), false);
});
