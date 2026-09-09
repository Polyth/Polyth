# Agent client adapters

Design verified against official documentation on 2026-09-09; actual client execution was not performed during this audit. Client versions, organization policy and trust prompts can affect loading. Confirm the active instructions/skill list in the installed client. These files configure repository context, not account permissions or cloud access.

| Client | Entry | How domain bodies are used |
| --- | --- | --- |
| Cursor | `.cursor/rules/polyth.mdc` -> `AGENTS.md` | Native discovery of `.agents/skills`; optional configured `.cursor/agents` roles |
| Codex | Root `AGENTS.md` | Native repository `.agents/skills` discovery where supported |
| Claude Code | `CLAUDE.md` imports `AGENTS.md` | One native `.claude/skills/polyth-guide` dispatcher reads canonical domain skill files on demand |
| OpenCode | Root `AGENTS.md` | Current docs support `.agents/skills`; old singular control-skill path remains a narrow redirect |
| Gemini CLI | `GEMINI.md` imports shared policy | Read the task router and selected skill explicitly; no blanket native-skill guarantee |
| GitHub Copilot | `.github/copilot-instructions.md` | Shared-policy/router pointers; availability depends on the Copilot feature/client |
| Plain ChatGPT or another file-reading agent | `docs/agents/CHATGPT.md` + an explicit context bundle/files | Manual/connector retrieval; no claim that a conversation automatically reads a repo |

Claude's single dispatcher deliberately avoids 27 mirrored skill bodies. It provides one native command, not 27 native Claude slash commands. The canonical bodies remain equally readable with ordinary file tools. Cursor/OpenCode may also discover that unique dispatcher; its name does not collide with domain skills.

No symlinks are required, so the archive consists of ordinary portable files. No global settings, auto-run hooks, permission allowlists, model selections, MCP credentials or user-level directories are changed. Existing `.opencode/opencode.json` is left untouched even though its paths are machine-specific; configure the local instance separately when authorized.

## Smoke-check in each client

Open the repo and start a fresh task. Ask the agent to identify its active project policy, the mobile skill path and one current code entry without changing files. Confirm it can read the relevant skill and distinguish baseline evidence from live behavior. For Claude invoke `/polyth-guide mobile`; for a generic client attach/read the bootstrap and task packet. A response that merely repeats filenames is not proof the files were loaded—request a source-specific constraint and path.

## Official references

- Cursor skills: https://cursor.com/docs/skills
- Cursor rules and subagents: https://cursor.com/docs/rules and https://cursor.com/docs/subagents
- Claude project memory/imports: https://code.claude.com/docs/en/memory
- Claude skills: https://code.claude.com/docs/en/skills
- Codex skills and AGENTS: https://developers.openai.com/codex/skills/ and https://developers.openai.com/codex/guides/agents-md/
- OpenCode skills/rules: https://opencode.ai/docs/skills/ and https://opencode.ai/docs/rules/
- Gemini project context: https://geminicli.com/docs/cli/gemini-md/
- Copilot repository instructions: https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot
- Agent Skills format: https://agentskills.io/specification

Recheck official docs before adding client-specific fields or promising new discovery behavior. A repository skill is guidance, not an enforcement sandbox.
