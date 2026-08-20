# Settings, integrations, plugins, and MCP

## Current Polyth baseline

`SettingsView.tsx` already has a page sidebar, page-title filtering, `settings.pages` contributions, and pages for Appearance, Chat, Notifications, Sessions, Shortcuts, Voice, Integrations, Usage, Projects, Git, Models, Agents, Behavior, Commands, MCP, and Plugins. Appearance/chat/notification preferences persist in `polyth.settings`; built-in plugin toggles persist through `prefs.ts`. MCP entries are currently local placeholders and explicitly do not connect. Extend these pages instead of adding a second settings shell.

## 1. Item-level settings search

**Source:** polyth #1592; Paseo #2160.

Each page registers searchable items:

```ts
interface SettingsSearchItem {
  id: string;
  pageId: string;
  label: string;
  description?: string;
  keywords?: string[];
  focusTarget: string;
}
```

Search results group by page, include label/hint/keywords, support arrow/Enter/Escape, and route to the page then focus/highlight the exact row. Plugin-contributed pages may include item descriptors in their slot props. Keep title filtering as fallback for contributions without item metadata.

Add `settings/registry.ts`, `.settings-results`, `.settings-result`, `.settings-row.flash`. No API/persistence. Test duplicate IDs, disposed plugin items, diacritics, keyboard focus, hidden item, and no matches.

## 2. Editor font size and visual settings

**Sources:** polyth #2065, #1318, #264.

Add numeric `editorFontSize` (11–24, default 14) to `UiSettings`; apply `--editor-font-size` to composer, file editor, diff code, terminal input, and code blocks. Existing `chatWidth`, density, reduced motion, and token variables remain authoritative. Reject arbitrary CSS values.

Use semantic design tokens:

```css
--surface-0; --surface-1; --surface-raised;
--text-primary; --text-muted;
--accent; --danger; --warning; --success; --info;
--border-subtle; --focus-ring; --editor-font-size;
```

Do not rename all tokens in one feature PR; add compatibility aliases and migrate touched components. Test parse/sanitize, min/max, immediate application, reload, contrast, and reduced motion.

## 3. Global behavior instructions

**Source:** polyth #1079.

Behavior settings edit a server-owned global instruction file and preview its resolved path:

```http
GET /api/settings/behavior → {"text":"...","revision":"...","pathLabel":"global AGENTS.md"}
PUT /api/settings/behavior {"text":"...","expectedRevision":"..."}
→ {"text":"...","revision":"..."}
```

`packages/server` owns safe file I/O under the configured Polyth data/config directory. Do not allow a client-supplied path. Use atomic writes, a 256 KiB limit, revision conflicts, and preserve newline style. `packages/backend-opencode` is the only package that may apply this text to backend configuration.

Because behavior text is model-visible, append `behavior/instructions-applied {revision,digest,scope:"global"}` to a session before starting a turn under a newly applied revision; the event may include the actual text only if replay requires it. Prefer storing a versioned snapshot reference so old sessions remain reproducible.

Components/classes: `BehaviorInstructionsEditor.tsx`, `.behavior-editor`, `.revision-conflict`.

Test concurrent saves, invalid encoding, atomic failure, empty reset, session created before/after revision, and no direct SDK/config access outside the adapter.

## 4. MCP configuration manager

**Sources:** polyth #473, #2776.

Replace local placeholder entries with a server-owned typed model:

```ts
type McpTransport =
  | { kind: "stdio"; command: string; args: string[]; envKeys: string[] }
  | { kind: "http"; url: string; headersSecretRefs: string[] };

interface McpServerDto {
  id: string; name: string; transport: McpTransport;
  enabled: boolean; status: "disabled"|"starting"|"connected"|"error";
  lastError?: string; revision: number;
}
```

```http
GET    /api/mcp/servers
POST   /api/mcp/servers
PATCH  /api/mcp/servers/:id
DELETE /api/mcp/servers/:id
POST   /api/mcp/servers/:id/test
POST   /api/mcp/servers/:id/authorize
```

Server routes call an `McpConfigService` capability. Only `packages/backend-opencode` implements runtime apply/restart and authorization; generic contracts/server never import the SDK. Secrets are stored through a secret-store seam and returned only as key names/redacted values.

UI: `McpSidebar`, `McpPage`, `McpServerForm`, `EnvKeyEditor`, `AuthorizationDialog`; classes `.mcp-list`, `.mcp-status`, `.mcp-form`, `.secret-redacted`.

Test command argv (no shell interpolation), URL schemes, duplicate names, secret non-disclosure, revision conflict, restart failure rollback, disabled entry, auth cancel, adapter absent.

## 5. Managed plugin lifecycle and integrations dashboard

**Sources:** polyth #1375, #2910; Paseo #3222, #3446.

Polyth's built-in plugin toggles are already useful but are not an install manager. Add a server-owned trusted local plugin registry:

```ts
interface InstalledPluginDto {
  id: string; name: string; version: string; source: string;
  trust: TrustClass; enabled: boolean;
  status: "installed"|"loading"|"ready"|"error"|"disabled";
  update?: { version: string };
  capabilities: string[]; contributions: UiSlotItem[];
  lastError?: string;
}
```

```http
GET    /api/plugins
POST   /api/plugins/install {"source":"npm:@scope/name@version|file:relative-path"}
POST   /api/plugins/:id/reload
POST   /api/plugins/:id/enable
POST   /api/plugins/:id/disable
POST   /api/plugins/:id/update
DELETE /api/plugins/:id
GET    /api/plugins/:id/logs?after=&limit=
```

Install latest explicit versions through npm's package manager APIs/child process with fixed argv. Never execute registry metadata. Install into a dedicated data directory, verify manifest and package integrity, stage before atomic activation, and roll back on load failure. File sources must remain under a configured trusted plugin directory.

The kernel owns scoped setup/disposal; disable/reload must remove services, routes, jobs, event handlers, and slots. Capture bounded stdout/stderr with secret redaction. Integrations dashboard groups first-party toggles, installed third-party plugins, MCP servers, and “coming soon” entries that are visibly non-interactive.

UI: `IntegrationsPage`, `ThirdPartyIntegrationsSection`, `PluginDetails`, `PluginLogViewer`, `InstallPluginDialog`; classes `.integration-card`, `.plugin-trust`, `.plugin-log`.

Test install interruption, malformed manifest, capability version mismatch, duplicate ID, dispose leak, reload failure, path traversal, huge logs, redaction, offline registry, and uninstall with active tabs.

## 6. Plugin trust and contribution policy

Each `TrustClass` maps to explicit grant text:

- `ui-only`/`pure`: no workspace/network/device access.
- `workspace`: project-scoped files/processes with permission checks.
- `network`: declared origins.
- `device`: browser/device APIs.
- `privileged`/`credentialed`: explicit install-time and runtime confirmation.

Plugins cannot supply arbitrary server URLs or bypass `/api`/`/ws`. UI modules are resolved through an allowlisted module registry; server manifests carry descriptors, not executable JSX. A plugin that wants model-visible context calls a session capability that appends an event first.

## 7. About/service URLs and health

**Source:** polyth #2669.

Extend existing health rather than creating an unauthenticated diagnostic dump:

```http
GET /api/system/info
→ {
  "version":"0.1.0",
  "applicationUrl":"http://127.0.0.1:4400",
  "tunnelUrl":null,
  "dataDirLabel":"…",
  "capabilities":["…"]
}
```

Only return configured public URLs; never derive from an untrusted Host header. Redact filesystem paths to labels unless the request is local/admin. About page provides copy buttons and connection status.

Test forwarded headers, tunnel absent, IPv6, remote request redaction, clipboard denial.

## 8. Customizable shortcuts

**Source:** polyth #457; Paseo #2160.

`@polyth/hotkeys` already centralizes commands. Add user bindings:

```ts
interface ShortcutBinding {
  commandId: string;
  sequence: string[];
  when?: string;
}
```

Persist `polyth.shortcuts.v1`. The editor records key chords, detects exact/prefix conflicts, supports reset per command/all, searches label/category/keys, and never shadows browser-reserved commands silently. Commands contributed through `commandPalette.commands` may declare defaults and categories.

Components/classes: `ShortcutRecorder`, `ShortcutConflictDialog`, `.shortcut-row`, `.shortcut-keys`, `.shortcut-conflict`.

Test Mac/control normalization, international layouts, composition, chord timeout, disposed commands, conflicting scopes, input-field suppression, and reset migration.

## Ownership and order

1. Typed settings item/shortcut registries.
2. Visual preference additions.
3. Server behavior and system-info routes.
4. MCP contract with adapter implementation.
5. Plugin registry, trust checks, loader lifecycle, and logs.
6. Integrations UI and update flow.

Do not store MCP/plugin configuration solely in localStorage. Browser layout preferences may remain local; runtime-affecting configuration is server-owned and revisioned.

## Global implementation contract

- Node 22 erasable TypeScript; `.ts` local imports; no enums, namespaces, or parameter properties.
- Cross-package imports use workspace names.
- Only `packages/backend-opencode` reads/applies OpenCode, MCP, or backend plugin configuration.
- Log behavior/plugin-provided model context before display/use.
- Extend `/api` and `/ws`; no parallel management server.
- Settings and integration pages use typed slots.
- Tests use `node --test` and plain `node:assert`.
