# Agent knowledge router

Use [root policy](../../AGENTS.md) once, one primary skill, and necessary cross-cutting guidance. This is a navigation system, not a requirement to load every file. The audit baseline is `d70f875ecb919a0a7d59488fc7ddafc47915b558`; current source remains necessary for exact edits.

```sh
node scripts/agent-kit.mjs context mobile
node scripts/agent-kit.mjs context --path packages/commands/src/catalog.ts
node scripts/agent-kit.mjs doctor harnesses
```

| Area | Canonical skill | Typical risk |
| --- | --- | --- |
| `orientation` | [Task routing and evidence](../../.agents/skills/polyth-orientation/SKILL.md) | normal |
| `packages` | [Feature package development](../../.agents/skills/polyth-packages/SKILL.md) | high |
| `design` | [Design, styling and accessibility](../../.agents/skills/polyth-design/SKILL.md) | normal |
| `web-ui` | [Web UI, widgets and workbench](../../.agents/skills/polyth-web-ui/SKILL.md) | normal |
| `architecture` | [Core architecture and system evolution](../../.agents/skills/polyth-architecture/SKILL.md) | critical |
| `contracts` | [Public contracts and browser boundaries](../../.agents/skills/polyth-contracts/SKILL.md) | critical |
| `sessions` | [Canonical sessions, events and recovery](../../.agents/skills/polyth-sessions/SKILL.md) | critical |
| `harnesses` | [Harness integration and safe switching](../../.agents/skills/polyth-harnesses/SKILL.md) | critical |
| `models` | [Model catalogs, capabilities and provider settings](../../.agents/skills/polyth-models/SKILL.md) | high |
| `mobile` | [Mobile iOS and Android development](../../.agents/skills/polyth-mobile/SKILL.md) | high |
| `link` | [Polyth Link, QR pairing and remote policy](../../.agents/skills/polyth-link/SKILL.md) | critical |
| `desktop` | [Desktop shell and distribution](../../.agents/skills/polyth-desktop/SKILL.md) | high |
| `debug` | [Debugging and regression diagnosis](../../.agents/skills/polyth-debug/SKILL.md) | normal |
| `performance` | [Performance, resource use and responsiveness](../../.agents/skills/polyth-performance/SKILL.md) | high |
| `testing` | [Risk-based testing and honest completion](../../.agents/skills/polyth-testing/SKILL.md) | normal |
| `security` | [Security, Spaces and authorization](../../.agents/skills/polyth-security/SKILL.md) | critical |
| `storage` | [Persistence and migrations](../../.agents/skills/polyth-storage/SKILL.md) | critical |
| `build-release` | [Build failures, CI and releases](../../.agents/skills/polyth-build-release/SKILL.md) | high |
| `integrations` | [External integrations and tools](../../.agents/skills/polyth-integrations/SKILL.md) | high |
| `voice` | [Voice, dictation and media pipelines](../../.agents/skills/polyth-voice/SKILL.md) | high |
| `files-editor` | [Files, resources and editor workflows](../../.agents/skills/polyth-files-editor/SKILL.md) | high |
| `orchestration` | [Multi-agent execution and handoff](../../.agents/skills/polyth-orchestration/SKILL.md) | high |
| `snapshot` | [Snapshot import and continuity](../../.agents/skills/polyth-snapshot/SKILL.md) | critical |
| `refactor` | [Refactoring and simplification](../../.agents/skills/polyth-refactor/SKILL.md) | high |
| `review` | [Code review and acceptance](../../.agents/skills/polyth-review/SKILL.md) | normal |
| `knowledge` | [Agent knowledge maintenance](../../.agents/skills/polyth-knowledge/SKILL.md) | normal |
| `live-control` | [Authorized live Polyth control](../../.agents/skills/polyth-live-control/SKILL.md) | critical |

Choose by intent, not only filename. Debugging adds `debug` to the owner. UI adds `design` to web/mobile ownership. Security, migrations and shared contracts override a lower local risk. `context --path` can return multiple relevant areas; choose the smallest set that covers the actual behavior. An unmatched path requires targeted investigation, not presumed low risk.

## Reference shelf — open only when relevant

[Architecture and owners](architecture.md) · [Command ownership](commands.md) · [Verification matrix](verification.md) · [Evidence discipline](evidence.md) · [Known documentation drift](known-drift.md) · [Security](security.md) · [UI states](ui-checklist.md) · [Mobile evidence matrix](mobile-matrix.md) · [Debug playbook](debug-playbook.md) · [Performance](performance.md) · [Orchestration](orchestration.md) · [Maintenance](maintenance.md) · [Tool CLI](tooling.md) · [Client compatibility](client-compatibility.md) · [ChatGPT handoff](CHATGPT.md) · [Installation](INSTALL.uk.md) · [Audit](AUDIT.uk.md).

Templates are optional, not paperwork for every one-line fix: [task](templates/task.md), [evidence](templates/evidence.md), [incident](templates/incident.md), [handoff](templates/handoff.md), [ADR](templates/adr.md), [migration](templates/migration.md), [UI acceptance](templates/ui-acceptance.md).
