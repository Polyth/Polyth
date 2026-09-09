# Working on Polyth with an agent

Start at [AGENTS.md](AGENTS.md), then the [task router](docs/agents/README.md). Do not feed the whole documentation tree to a model.

The repository uses a single canonical rules file, 27 on-demand domain skills, small client adapters and dependency-free navigation/validation tools. The system describes where to inspect current implementation; it does not replace tests or certify feature completeness.

```sh
node scripts/agent-kit.mjs map
node scripts/agent-kit.mjs context mobile
node scripts/agent-kit.mjs doctor mobile
node scripts/agent-kit.mjs impact --base HEAD
```

Installation and rollback: [INSTALL.uk.md](docs/agents/INSTALL.uk.md). Architecture: [owner map](docs/agents/architecture.md). Client setup: [compatibility](docs/agents/client-compatibility.md). Maintenance: [knowledge workflow](docs/agents/maintenance.md). Audit scope and limitations: [audit](docs/agents/AUDIT.uk.md).

No runtime code, lockfile, model selection, signing configuration, MCP connection or tool permission is changed by this kit. Existing specialized UI/security/protocol documentation remains in place and is read on demand. Older source-specific assertions must be reconciled with current implementation; see the explicit drift ledger.
