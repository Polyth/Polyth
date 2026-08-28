# OpenCode real-world validation artifacts

Create one directory per scenario and run:

```text
OC-REAL-NNN/
  RUN-ID/
    manifest.json
    result.md
    screenshots/
    video/
    state/
```

`manifest.json` records redacted environment/version/SHA, protocol, endpoint generation,
fault seed and related log paths. `result.md` contains the pass/fail classification and
evidence index. `state/` holds bounded before/after SQLite, process and filesystem extracts.
Never store credentials, full home configuration, or unrelated session content.

Raw service/proxy logs belong in `logs/opencode-real-world/`, not here.
