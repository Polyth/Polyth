# OpenCode real-world validation logs

Store bounded, redacted logs by scenario and run:

```text
OC-REAL-NNN/
  RUN-ID/
    polyth.log
    opencode.log
    wire.ndjson
    websocket.ndjson
    faults.ndjson
```

Use one timestamp clock and connection/request IDs across files. Preserve HTTP status,
header names, body byte counts, SSE IDs, process signals, endpoint generations and fault
boundaries. Redact authorization/cookies/tokens and truncate unrelated payloads. Large raw
dumps should be compressed and referenced from the matching artifact manifest.
