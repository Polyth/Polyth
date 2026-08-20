# Real browser panel and agent control

## Source and current gap

**Source:** polyth #2883.

Polyth currently starts a project dev server in `packages/preview` and embeds its URL in `PreviewView.tsx`. The Console and Network tabs are placeholders. polyth replaced a preview proxy with a Chromium-backed browser surface, navigation toolbar, annotations, and an agent browser-control broker.

A web page cannot host Electron's native `BrowserView`. Polyth therefore must not pretend an ordinary cross-origin iframe provides browser automation. Implement a server-owned Chromium session and a web surface that streams its viewport/input. Keep the existing iframe preview as a low-cost fallback when controlled browsing is unavailable.

## Acceptance criteria

- Preview and Browser are one surface with Back, Forward, Reload, Stop, address bar, viewport size, inspector/annotation toggle, and Open externally.
- Starting a project dev server may navigate the browser to its URL; users may also enter an allowed URL.
- The user and agent operate the same browser session. User clicks/typing and agent actions update one viewport and history.
- Agent actions are visible, attributable, abortable, and permission-gated. Page observations become model context only after an event is appended.
- Session closure destroys browser context, cookies, storage, downloads, and temporary screenshots unless the user explicitly chooses a persistent profile.
- If Chromium is unavailable, the existing iframe preview remains functional and reports why control is unavailable.

## Package boundary

This capability warrants a new `packages/browser` because it owns a subprocess, security policy, session lifecycle, input protocol, and captured artifacts distinct from dev-server lifecycle. `packages/preview` continues to start/stop project servers and may provide the initial URL.

```ts
interface BrowserService {
  create(input: BrowserCreateInput): Promise<BrowserSession>;
  navigate(id: string, url: string): Promise<BrowserSnapshot>;
  action(id: string, action: BrowserAction): Promise<BrowserSnapshot>;
  observe(id: string, opts?: BrowserObserveOptions): Promise<BrowserObservation>;
  close(id: string): Promise<void>;
  onFrame(cb: (frame: BrowserFrame) => void): Disposable;
  onEvent(cb: (event: BrowserRuntimeEvent) => void): Disposable;
}
```

Use the latest `playwright-core` when implementing and require a configured Chromium executable; do not download a browser during normal server start. Tests inject a fake driver. `packages/browser` does not import or call OpenCode. Tool registration/translation occurs only in `packages/backend-opencode`, which consumes the browser capability and exposes the provider-specific tool.

## Data and APIs

```ts
interface BrowserSession {
  id: string;
  projectId: string;
  sessionId?: string;
  url: string;
  title: string;
  status: "starting" | "ready" | "closed" | "failed";
  viewport: { width: number; height: number; deviceScaleFactor: number };
  revision: number;
}

type BrowserAction =
  | { kind: "click"; target: BrowserTarget }
  | { kind: "type"; target: BrowserTarget; text: string; submit?: boolean }
  | { kind: "press"; key: string }
  | { kind: "scroll"; x: number; y: number }
  | { kind: "select"; target: BrowserTarget; value: string }
  | { kind: "wait"; condition: "network-idle"|"selector"; value?: string; timeoutMs?: number };

type BrowserTarget =
  | { selector: string }
  | { role: string; name?: string; exact?: boolean }
  | { point: { x: number; y: number }; frameRevision: number };
```

REST extends the current protocol:

```http
POST   /api/browser/sessions {"projectId":"...","sessionId":"...","url":"..."}
GET    /api/browser/sessions/:id
POST   /api/browser/sessions/:id/navigate {"url":"..."}
POST   /api/browser/sessions/:id/actions {"action":{...},"actor":"user"}
POST   /api/browser/sessions/:id/observe {"includeScreenshot":true,"includeAccessibility":true}
DELETE /api/browser/sessions/:id
```

Use `/ws` messages:

```json
{"type":"browser/subscribe","browserSessionId":"...","afterRevision":12}
{"type":"browser/frame","browserSessionId":"...","revision":13,"mime":"image/webp","data":"..."}
{"type":"browser/event","browserSessionId":"...","event":{"kind":"navigation","url":"..."}}
```

Binary WS frames are preferable for screenshots; if the current gateway only carries JSON, first extend its typed envelope rather than creating another socket. Apply backpressure and keep only the newest unacknowledged frame.

Browser-session state is ephemeral and stored in memory. Optional persistent profiles require an explicit project-scoped setting and a dedicated data directory; never place cookies in session events.

## Model-visible event ordering

Append before agent-facing display/context:

- `browser/action-requested {browserSessionId,actionId,actor,actionSummary}`
- `browser/action-completed {actionId,url,title,observationRef?,screenshotRef?}`
- `browser/action-failed {actionId,code,message}`
- `browser/observation {url,title,text,accessibilityDigest,screenshotRef?}` when observation is sent to the model

Raw high-frequency frames, pointer motion, console noise, and network telemetry are `ignorable` UI data and should not be appended. Store large screenshots as bounded attachment files and reference them with `AttachmentRef`; never base64-embed them in SQLite events.

## UI design

```text
BrowserView
├─ BrowserToolbar
│  ├─ history controls
│  ├─ BrowserAddressInput (IME-safe primitive)
│  ├─ viewport selector
│  └─ inspector/annotation/session controls
├─ BrowserViewport
│  ├─ latest frame
│  ├─ remote pointer/action highlight
│  └─ annotation overlay
└─ BrowserInspector
   ├─ Console
   ├─ Network
   ├─ Accessibility
   └─ Agent activity
```

Contribute through `workspace.main.tabs`/`workspace.right.tabs`; do not hardcode into `Main.tsx`. Classes: `.browser-view`, `.browser-toolbar`, `.browser-address`, `.browser-viewport`, `.browser-action-highlight`, `.browser-inspector`.

Pointer coordinates include the displayed frame revision and are rejected if stale. Prefer accessibility-role/selector targets for agent actions. The user may pause agent control without closing the browser.

## Security policy

- Default allowlist: the active project's preview origin and loopback origins on ports started by Polyth.
- External navigation requires a per-origin approval; deny private-network targets other than approved loopback, link-local metadata addresses, `file:`, `data:`, `javascript:`, browser internals, and downloads by default.
- Re-resolve DNS on redirects to prevent rebinding. Validate every redirect and subresource policy.
- Run an isolated context with no host filesystem access, extensions, saved passwords, clipboard, camera, microphone, geolocation, or notifications.
- Redact password fields, cookies, authorization headers, and configured secret patterns from observations/logs.
- Tool actions use existing permission guards. “Allow always” is scoped to origin + action family + project.
- Cap observation text, screenshot dimensions, console entries, response bodies, action timeout, and total browser lifetime.

## Edge cases and tests

Unit/contract tests with `node --test`:

- URL canonicalization, redirect/DNS rebinding, blocked schemes, origin approvals.
- Stale frame clicks, action timeout/abort, disconnect/reconnect, frame backpressure.
- Same session user/agent serialization and action IDs.
- Secret redaction, password omission, download denial, popup handling.
- Browser crash and dev-server restart, context cleanup, missing Chromium fallback.
- Event ordering: requested before completed/failed; observation logged before model consumption.
- Slot disposal closes sessions and removes WS subscriptions.

Browser walkthrough:

1. Start the project's dev server and open Browser.
2. Navigate, back/forward/reload, resize, type, and click.
3. Pause/resume agent control and run one approved browser action.
4. Verify action highlight/activity, Console/Network capture, and reconnect.
5. Attempt blocked external/private URL and verify the approval/denial path.

## Suggested implementation order

1. Contract, fake driver, lifecycle, and URL policy.
2. Chromium driver and observation redaction.
3. REST/WS frames with backpressure.
4. Browser surface and shared pane registry.
5. Permission guard and backend adapter tool bridge.
6. Console/network/annotation polish and persistent-profile opt-in.

## Global implementation contract

- Node 22 erasable TypeScript; explicit `.ts` local imports; no enums, namespaces, or parameter properties.
- Use workspace package imports and explicit capabilities.
- Only `packages/backend-opencode` may expose browser actions to OpenCode.
- Append observations/actions before they become model-visible.
- Extend `/api` and `/ws`, including typed binary support if needed.
- Mount through typed workspace surface slots.
- Tests use `node --test` and plain `node:assert`.
