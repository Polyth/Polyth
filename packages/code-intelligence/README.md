# @polyth/code-intelligence

Optional TypeScript and JavaScript language smarts for the code editor:
completions, hover details and problems. Off by default; enable it in
**Settings → Packages**.

## Ownership

- **The editor package owns CodeMirror.** `@polyth/editor` renders the editor
  and exposes the data-only `editor.intelligence` seam
  (`packages/editor/widgets/intelligence.ts`); provider packages never import
  CodeMirror.
- **This package owns the language service client.** `src/index.ts` is a pure
  factory (`createTypeScriptIntelligence(fetchImpl)`) that maps an
  `EditorIntelligenceRequest` onto `POST /api/editor/language` and degrades to
  an empty result on abort, `unavailable`, a non-2xx response or a malformed
  body. It never throws into the editor.
- **The route is the editor package's scoped route.** This package has no
  server routes; `src/serverEntry.ts` exists so the package is discovered and
  can be enabled/disabled.

## Wiring

`widgets/index.tsx` registers one slot contribution:

```ts
host.slots.register({
  slot: "editor.intelligence",
  id: "code-intelligence.typescript",
  render: () => null,
  meta: { provider },
});
```

Registration and removal are announced with the
`polyth:editor-intelligence` window event, because the host slot registry
exposes `list` only; the editor re-reads the slot and reconfigures every open
buffer. A host that later exposes a slot subscription is picked up through the
seam's optional `subscribe`.

## Verification

`test/provider.test.ts` covers request mapping, the `primary` repository
default, `unavailable`/non-2xx/malformed/throwing responses and abort
handling. The editor-side behaviour (completion apply, plain-text hover,
lint ranges and gutter, read-only buffers, language filtering, registration
removal) is covered by `packages/editor/test/intelligence.test.ts`.

## Not verified here

Real-browser rendering with a live TypeScript language service. The editor
tests run in happy-dom against fake providers.
