---
name: polyth-control
description: Use for ANY Polyth interaction: discover, inspect, create, message, steer, queue, stop, archive, debug, coordinate agents and sessions, answer requests, manage projects/goals/spaces/packages, or call a Polyth API.
---

# Polyth control

Use the local `polyth` MCP. It connects through Polyth's filesystem-protected
internal control socket, so authenticated UI mode does not block agent control
and no password or auth bypass is needed.

1. Call `polyth_capabilities` when the desired action or input is unclear. It
   lists every action, description, group, and enabled state.
2. Call `polyth_control` with `{ "action": "...", "input": { ... } }`.
3. Call `polyth_configure` to enable/disable/reset individual actions. Runtime
   changes last for this MCP process; set `POLYTH_CONTROL_DISABLED` in MCP config
   for a persistent comma-separated disabled list.

Common actions:

- `project.list`, `project.add`, `project.create`, `project.remove`
- `session.list`, `session.get`, `session.create`, `session.send`,
  `session.debug`, `session.cancel`, `session.archive`, `session.restore`,
  `session.fork`, `session.rewind`, `session.delete`
- `queue.list`, `queue.edit`, `queue.reorder`, `queue.remove`
- `permission.reply`, `question.reply`, `question.reject`, `secret.dismiss`
- `goal.get`, `goal.start`, `goal.pause`, `goal.resume`, `goal.stop`
- `catalog.models`, `catalog.providers`, `catalog.agents`
- `space.*`, `notification.*`, `package.list`, `system.*`
- `api.request` for any current or future non-auth, non-secret `/api` route

Use `delivery: "steer"`, `"queue"`, or `"interrupt"` with `session.send` when
appropriate. Forward `model: { providerID, modelID }`, `agent`, and other user
choices rather than silently replacing them.

Never send secret values through MCP. `secret.dismiss` is intentionally the
only secret-request action; saving a value belongs in Secure Safe UI. Confirm
ambiguous destructive actions (`session.delete`, `project.remove`, space/member
deletion) before calling them.
