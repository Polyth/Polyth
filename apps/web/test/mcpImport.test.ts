// F10: the JSON import parser maps pasted mcpServers blocks (Claude or
// OpenCode shape) to create inputs without ever throwing; env/header values
// become write-only secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMcpServersJson } from "../src/mcpImport.ts";

test("parses a Claude-style mcpServers block with env secrets", () => {
  const r = parseMcpServersJson(JSON.stringify({
    mcpServers: {
      airtable: { command: "npx", args: ["-y", "airtable-mcp-server"], env: { AIRTABLE_API_KEY: "pat-secret" } },
      docs: { url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer x" } },
    },
  }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.entries.length, 2);

  const [a, d] = r.entries;
  assert.equal(a?.name, "airtable");
  assert.deepEqual(a?.transport, { kind: "stdio", command: "npx", args: ["-y", "airtable-mcp-server"], envKeys: ["AIRTABLE_API_KEY"] });
  assert.deepEqual(a?.secrets, { AIRTABLE_API_KEY: "pat-secret" });
  assert.equal(a?.enabled, true);

  assert.deepEqual(d?.transport, { kind: "http", url: "https://mcp.example.com/sse", headersSecretRefs: ["Authorization"] });
  assert.deepEqual(d?.secrets, { Authorization: "Bearer x" });
});

test("parses the OpenCode shape (type local/remote, command array, environment)", () => {
  const r = parseMcpServersJson(JSON.stringify({
    mcp: {
      "local-x": { type: "local", command: ["bun", "x", "my-mcp"], environment: { K: "v" }, enabled: false },
      "remote-y": { type: "remote", url: "http://127.0.0.1:9000/mcp" },
    },
  }));
  assert.deepEqual(r.errors, []);
  const [l, remote] = r.entries;
  assert.deepEqual(l?.transport, { kind: "stdio", command: "bun", args: ["x", "my-mcp"], envKeys: ["K"] });
  assert.equal(l?.enabled, false);
  assert.deepEqual(remote?.transport, { kind: "http", url: "http://127.0.0.1:9000/mcp", headersSecretRefs: [] });
  assert.equal(remote?.secrets, undefined);
});

test("accepts the server map directly, without a wrapper key", () => {
  const r = parseMcpServersJson(JSON.stringify({ solo: { command: "srv" } }));
  assert.deepEqual(r.errors, []);
  assert.equal(r.entries[0]?.name, "solo");
});

test("malformed input collects errors instead of throwing", () => {
  assert.match(parseMcpServersJson("{oops").errors[0] ?? "", /not valid JSON/);
  assert.match(parseMcpServersJson("[1,2]").errors[0] ?? "", /expected a JSON object/);
  assert.match(parseMcpServersJson("{}").errors[0] ?? "", /no servers found/);

  const partial = parseMcpServersJson(JSON.stringify({
    mcpServers: {
      good: { command: "srv" },
      "no-command": { args: ["x"] },
      "bad-url": { url: "ftp://nope" },
      "not-object": 42,
    },
  }));
  assert.equal(partial.entries.length, 1);
  assert.equal(partial.entries[0]?.name, "good");
  assert.equal(partial.errors.length, 3);
  assert.match(partial.errors[0] ?? "", /needs a command/);
  assert.match(partial.errors[1] ?? "", /http\(s\)/);
  assert.match(partial.errors[2] ?? "", /must be an object/);
});
