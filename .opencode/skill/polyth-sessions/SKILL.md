---
name: polyth-sessions
description: Use when the user asks to read, create, message, stop, archive, or coordinate any Polyth session. Uses the local polyth MCP server.
---

# Polyth sessions

Use the `polyth` MCP tools for Polyth session work:

- `polyth_list_sessions` — discover sessions and projects.
- `polyth_get_session` — inspect messages, events, and status.
- `polyth_send_message` — continue or steer a session.
- `polyth_create_session` — start a session in a known project.
- `polyth_session_action` — cancel, archive, or restore a session.

Do not expose secret-request values through MCP. Confirm the target session before sending destructive actions or messages when the request is ambiguous.

## Configuration

Add this MCP entry to the OpenCode configuration that should access Polyth:

```json
{
  "mcp": {
    "polyth": {
      "type": "local",
      "command": ["node", "--experimental-strip-types", "/data/projects/polyth/packages/polyth-mcp/src/index.ts"],
      "environment": { "POLYTH_URL": "http://127.0.0.1:4400" }
    }
  }
}
```

Set `POLYTH_URL` to another reachable Polyth server when needed.
