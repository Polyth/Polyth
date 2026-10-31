@AGENTS.md

# Claude Code entry point

Use the shared operating contract above. Domain skills have one canonical copy under `.agents/skills/`; read the relevant `SKILL.md` and referenced files with available tools. The native `/polyth-guide` skill routes tasks to these bodies. Do not assume a filename reference automatically loads its contents.

Read only relevant reference sections. Do not mirror all canonical skills into `.claude/skills` or load the full library at startup. No permission bypass, MCP availability or subagent availability is implied by this file.
