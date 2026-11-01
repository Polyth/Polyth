# Spaces, tenancy, and the execution boundary

Status: **Phase 1 shipped.** Phases 2–5 are designed here and not implemented.
Nothing in this document describes behavior that does not exist unless it says
so explicitly.

---

## 1. What a Space is

A **Space** is Polyth's tenant: the unit that owns projects, sessions, files,
worktrees, knowledge, secrets, integrations, and executions. One person can
have several (Home / Hobby / Work); several people can eventually share one.

- User-facing name: **Space**.
- Internally: `spaceId` is the tenant id, `SpaceContext` is the resolved,
  validated tenant context.
- It is **not** called a workspace — Polyth already uses "workspace" for UI
  layout (`workspace-mode-switch`, workspace panes, workspace surfaces).

A Space is a **server-side security boundary**, never a client-side filter. The
UI never decides which tenant owns a resource.

```
request
  ↓ authenticate identity            (packages/server/src/auth.ts)
  ↓ resolve requested Space          (@polyth/tenancy · context.ts)
  ↓ validate membership              (@polyth/tenancy · store.ts)
  ↓ SpaceContext
  ↓ scoped services only             (packages/server/src/spaceScope.ts)
  ↓ resource operation
```

---

## 2. Architecture assessment of the pre-tenancy repository

### 2.1 Components affected

| Area | File(s) | Pre-tenancy state |
|---|---|---|
| Auth | `packages/server/src/auth.ts` | One shared UI password. Principals (`local-user`, `ui-session`, `paired-device`, `internal-service`) carry **no user identity**. |
| Gateway | `packages/server/src/http.ts` | One giant handler closing over a single global `sessions`/`projects`. |
| Route contract | `packages/contracts` `RouteRequest` | Carried `ingress` + `principal`, no tenant. |
| Projects | `packages/server/src/projects.ts` | Flat `projects.json`, no owner. |
| Sessions | `packages/session/src/index.ts` | One `sessions.db`; `projections` keyed only by session/project. |
| Session service | `packages/server/src/sessions.ts` (5.5k lines) | ~40 methods keyed by bare `sessionId`. |
| WS | `packages/server/src/ws.ts` | Events, projections, and notifications fanned out to **every** authenticated socket. |
| Labels | `packages/session` `labels` table | Global. Names visible to everyone. |
| Search | `packages/server/src/search.ts`, `routes/org.ts` | Matched over the full project + session inventory. |
| Package host | `packages/plugins/src/serverPackage.ts` | `storageDir` = the shared data root; a removable package writes only under `packageDataDir(host)` (`<data>/packages/<id>`) or `spaceStorage(ctx).packageDir(id)`. |
| Secrets | `packages/secure-safe` (Credential Vault) | One store, one manifest, deployment-wide. |
| Integrations | `packages/ssh/ssh.json`, `mcp.json`, `packages/agents/schedule.json` (formerly `packages/schedule/`), `workflows.json` | These stores remain deployment-wide; Knowledge and Memory use Space-owned package storage. |
| Execution | `backend-opencode`, `terminal`, `browser`, `git` worktrees | Direct host process/filesystem access, no executor seam. |

### 2.2 Single-user assumptions found

1. **No identity at all.** Authentication proves *possession of the password*,
   not *who you are*. Every principal was effectively the same person.
2. **Ownership by existence.** If a row is in `projects.json` or `projections`,
   any authenticated caller may read and mutate it.
3. **Global fan-out.** One WebSocket broadcast reached every socket; only
   capability grants (paired devices) narrowed it.
4. **Global caches and pools.** The runtime pool is keyed by `projectId` +
   resolved `cwd`; the model/agent catalog aggregated across *all* projects.
5. **Host filesystem browsing.** `/api/browse` lists arbitrary server
   directories for the folder picker.
6. **Package state is deployment state.** Every package writes to the one
   `storageDir`; a tenant-installed package would run in-process with full
   control-plane privileges.
7. **Recovery by session id alone.** Restart recovery re-adopts operations
   without any tenant check (there was no tenant).

### 2.3 Proposed ownership model (implemented)

```
User ──< Membership >── Space
                          ├── Projects        (spaceId on the row)
                          ├── Sessions        (spaceId on the projection)
                          ├── Labels          (space_id column)
                          ├── Folders         (through their project)
                          └── Storage root    data/spaces/<slug>-<id>/
```

`Membership(userId, spaceId, role)` with `role ∈ viewer | member | admin |
owner`. Phase 1 only ever *creates* `owner` memberships, but the store,
authorization, and API accept the full set, so multi-member Spaces need no
schema change.

User-owned (deliberately **not** duplicated per Space): locale, theme,
typography, hotkeys, and other account-level UI preferences. Space-level
overrides can be layered later without moving the storage.

### 2.4 TenantContext propagation (implemented)

`SpaceContext` is only ever *constructed* by the server, after authenticating
and checking membership. Receiving one is proof the check happened.

```ts
interface SpaceContext {
  spaceId; spaceSlug; userId; role; deployment; storageDir;
}
```

It reaches code three ways:

1. **`RouteRequest.space`** — every contributed route gets it. It is a lazy
   getter: routes also see non-`/api` paths (static assets) where there is no
   tenant to resolve, so reading it is what triggers resolution.
2. **`SpaceServicesFor = (ctx) => SpaceServices`** — route factories receive
   the *resolver*, not the services. A handler must pass a context to get a
   session or project service at all.
3. **`host.spaceStorage(ctx)`** — packages get their own directory inside one
   Space, with `path()` doing canonical validation.

The gateway itself has **no unscoped services**: `HttpDeps` has no `sessions`
or `projects` field. "Forgot to scope this route" is not an available bug.

### 2.5 Storage / schema changes (implemented)

- `data/tenancy.json` — users, spaces, memberships, per-device selections
  (0600, atomic replace).
- `data/spaces/<slug>-<shortId>/{projects,worktrees,attachments,runtime,packages,audit}/`
  — per-Space storage root, created on first resolution.
- `data/spaces/<…>/personal/<sha256(userId)[:32]>/` — a member's personal
  project folder (`Project.personal`), created by `POST /api/projects/personal`
  (`personalProjectPath`, `projectResourceAuthority.ts`). The server picks the
  path; no principal id text becomes a path component. Because the digest is
  derivable, nothing under `spaces/*/personal/` can be added as an ordinary
  project (`reservedForPersonal`, checked before any lookup, so the refusal is
  the same whether the folder exists).
- `Project.spaceId?` in `projects.json`; a personal project also stores its
  owner (`personalOwner`, never sent to clients).
- `SessionProjection.spaceId?`, plus session-store **migration v10**: a
  generated `space_id` column on `projections` with its own indexes (mirroring
  the existing `project_id` column) so listing and fan-out filter at the index.
- **Migration v11**: `labels.space_id`.

Existing paths are untouched. `sessions.db`, `projects.json`, and every
package's config file stay exactly where they were; only ownership is written.

### 2.6 API changes (implemented)

New:

- `GET /api/spaces` → `SpacesStateDto` (only Spaces this identity belongs to)
- `POST /api/spaces` · `PATCH /api/spaces/:id` · `DELETE /api/spaces/:id`
- `POST /api/spaces/:id/activate` (remembers the choice, sets `polyth_space`)
- `GET|POST /api/spaces/:id/members`, `DELETE /api/spaces/:id/members/:userId`

Active-Space resolution order, each candidate re-checked against membership:

1. `X-Polyth-Space` header (explicit; an unauthorized value is a hard 404)
2. server-side remembered selection for this device
3. `polyth_space` cookie (a hint; an invalid value falls back silently)
4. the user's default Space

Internal control-plane callers (`internal-service` principals) take a separate
path — `resolveInternal()` — precisely so that "no identity" and "the operator"
are different code paths rather than a fallback inside the normal resolver.

No endpoint accepts a tenant id in a request body. Cross-tenant access always
answers **`not-found`, never `forbidden`** — a distinguishable denial would
turn any id parameter into an existence oracle.

### 2.7 Execution abstraction plan

Contracts exist in `@polyth/contracts` (`ExecutionBackend`, `RunnerSpec`,
`RunnerHandle`, `ExecutionPolicy`, `ExecCommand`, `ExecResult`); no executor is
implemented yet — today's host execution is unchanged. See §5.

### 2.8 Package-runtime implications

`ServerPackageHost` carries `spaceStorage(ctx)`, `systemSpaceContext(spaceId)`
and `deployment`. Background package work must derive a Space id from a
canonical project/session and ask the host for its system context; packages
must not fabricate a context or reconstruct a tenant storage path.
`storageDir` is retained and re-documented as the **shared, non-tenant** root —
correct for deployment-wide state (a binary cache, a trusted registry), wrong
for anything a Space owns. Packages holding tenant state there are being
migrated; new tenant state goes through `spaceStorage`. See §6.

### 2.9 Security risks (current, honest)

| Risk | State |
|---|---|
| Core resources (projects, sessions, labels, folders, search, WS) | **Closed** — scoped facades + indexed filters + per-socket binding, with tests. |
| Feature-package state (`ssh.json`, `mcp.json`, `secure-safe`, `schedule.json`, `workflows.json`, `permissions.json`) | **Open** — these stores remain deployment-wide (ssh and schedule now under their `<data>/packages/<id>` directory); browser shots are per-Space `packages/browser/browser-shots`. Knowledge and Memory now resolve through `spaceStorage(space).packageDir("knowledge")`; the remaining listed integrations still cross Space boundaries. |
| Execution | **Open** — everything runs on the host as the server user. |
| Tenant packages | **Open** — a package's server entry runs in the control plane. Gated by `allowsTenantPackagesInControlPlane`, which is only true for `local-trusted`. |
| Host filesystem browsing | **Closed for hosted** — `/api/browse` refuses under `multi-tenant-sandboxed`. |
| Runtime pool / model catalog | **Partly closed** — the catalog now aggregates only the caller's Space; the pool is keyed by project + resolved cwd, and project ids are Space-owned, so pool keys cannot collide across Spaces. Warm processes are still shared per project, which is correct (one project belongs to exactly one Space). |
| Restart recovery | **Partly closed** — recovery runs before the gateway serves and re-derives ownership from the adopted projections, but there is no tenant assertion inside the recovery path itself. See §7. |
| People within one Space | **Partly closed** — messages record their author, tools see the acting person, drafts, read cursors and pins are per person, and a person's new chats are private until shared with named people or the whole Space at view/collaborate/manage access (§14 stages 1–2). Personal connected accounts, administration and the remaining stores are §14 stages 3–5. |
| Identity | **Per-account** — the canonical identity authority (`@polyth/identity`) issues per-user credentials and sessions; the instance owner creates local accounts and grants Space membership. Owner-set account guardrails narrow a household account (§11). A Polyth Desktop owner who chose "just me" has no credential until they set a password (§3.1). |
| Internal control callers | **Explicit** — the filesystem-protected control socket (`data/control.sock`, Polyth's own MCP and the `polyth` CLI) does not resolve a tenant from ambient state. `SpaceGateway.resolveInternal(spaceId?)` binds it to the installation owner and, in `multi-tenant-sandboxed`, refuses without an explicit Space. Outside `local-trusted` the socket answers only `GET /api/health` and `GET /api/agent`: agents run as the server's OS user and could open it, so people use a per-person CLI token there instead ([CLI](../dev/cli.md)). |

### 2.10 Migration strategy (implemented)

On every boot: ensure the bootstrap user (`usr_owner`) and the default
**Personal** Space exist, then adopt every project and projection that still
has no owner. Idempotent, no wizard, nothing moves on disk. Rollback is
`rm data/tenancy.json` — the next boot rebuilds the same user id and a Personal
Space, and re-adopts whatever it finds. Covered by
`packages/server/test/spaceMigration.test.ts`.

### 2.11 Implementation phases

| Phase | Scope | State |
|---|---|---|
| 1 | Identity, Space, membership, `SpaceContext`, scoped services, migration, switcher | **done** |
| 2 | Execution boundary — route host execution through `ExecutionBackend` | designed (§5) |
| 3 | Disposable container executor + worktree/session lifecycle | designed (§5) |
| 4 | Hardening: rootless, namespaces, seccomp, quotas, network policy, secret broker, package sandbox, audit | designed (§4, §6, §8) |
| 5 | Hosted execution: remote workers, gVisor/microVM, pools, abuse controls | designed (§5) |

### 2.12 Files changed in Phase 1

```
packages/tenancy/**                       new package (store, context, paths, audit, migrate)
packages/contracts/src/index.ts           tenancy + execution contracts; RouteRequest.space
packages/session/src/index.ts             migrations v10/v11, space-scoped queries
packages/session/src/webApi.ts            spaces API client
packages/plugins/src/serverPackage.ts     spaceStorage/deployment on the host; tenancy is infrastructure
packages/server/src/spaces.ts             new — gateway composition + migration
packages/server/src/spaceScope.ts         new — scoped facades and the ownership guard
packages/server/src/routes/spaces.ts      new — /api/spaces
packages/server/src/projects.ts           ProjectRegistry with forSpace/adoptIntoSpace
packages/server/src/http.ts               resolves the context; no unscoped services
packages/server/src/ws.ts                 per-socket Space; filtered fan-out
packages/server/src/index.ts              composition
packages/server/src/remotePolicy.ts       paired devices may list/switch Spaces
packages/server/src/routes/{org,control,context,queue,projects,runtimeEpoch,sessionRetention,agentSessions,browse}.ts
apps/web/src/spaces.ts                    new — client state
apps/web/src/components/SpaceSwitcher.tsx new — switcher + manage dialog
apps/web/src/components/{Header,Sidebar}.tsx  mount points
apps/web/src/styles.css, i18n/locales/*   switcher styles and strings
```

---

## 3. Deployment profiles

One value decides policy instead of `if (cloud)` checks scattered through the
codebase. `POLYTH_DEPLOYMENT_PROFILE`, read once at boot:

| Profile | Tenants | Execution | Host browsing | Tenant packages in-process |
|---|---|---|---|---|
| `local-trusted` (default) | one trusted operator | host | yes | yes |
| `server-trusted` | trusted humans, isolated data | host | yes | no |
| `multi-tenant-sandboxed` | untrusted | sandboxed (required) | no | no |

Helpers: `allowsHostFilesystemBrowsing`, `allowsTenantPackagesInControlPlane`.
Add new decisions as helpers next to them, never as inline profile comparisons
in feature code.

### 3.1 Access modes: accounts, or a password-less Desktop owner

The installation row carries `access_mode` (control-plane migration v13,
`localAccessMigration.ts`; read through `identity.accessMode()`):

- **`accounts`** — every installation before v13 and every setup with a
  password. The owner signs in with a credential.
- **`local`** — Polyth Desktop's first run when the person chose "just me" or
  "me, from my phone too" ([UI §3.5](../dev/ui.md#35-first-run-setup-and-sign-in-screens)).
  `setup.completeLocal` provisions the same owner, organization and Personal
  Space as `setup.complete`, with no password, recovery codes or passkey. The
  only owner session comes from the Desktop main process, in-process
  (`issueLocalOwnerSession`, see [Desktop](../dev/desktop.md)); neither call is
  an HTTP route, and the server exposes both only to a host that boots with
  `desktopOwnerChannel: true`. Paired phones work as before (Polyth Link
  pairing is approved from the Desktop window and stays default-deny).

`local` is chosen during setup only: SQL triggers refuse switching a ready
installation to it or re-inserting the row as `local`, and Desktop sessions
are issued only to an owner who truly holds no password, passkey or linked
identity. It ends when the owner protects the account
(`ownerCredential.prepareRecovery` → `establish`: the fixed `owner` login, a
password and 8 recovery codes on the same user; no data moves) and never comes
back. Launch sessions are not elevated; both steps need the Desktop window's
own session confirmed in-process within five minutes
(`confirmLocalOwnerSession`, Desktop IPC `desktop:session:confirm`), so a copied
cookie can never choose the owner's password (`owner-confirmation-required`). While `local`, everything that admits another person or another way in
answers `owner-credential-required` (409): creating accounts, passkey
registration, external sign-in links and sign-in provider configuration, and —
through `sessions.require(token, true)` — every action that otherwise asks for
a recent sign-in (CLI tokens, approving a CLI sign-in, no-token CLI trust,
account guardrails/limits/permissions). A session's age never stands in for a
credential. Boot refuses `POLYTH_PUBLIC_ORIGIN` (`controlPlanePreflight.ts`). A Docker or
standalone server never offers `local`: it keeps the setup code and password.

---

## 4. Secrets (Phase 4)

Never mount the Space's secret store into a runner. Execution asks for a
**reference**; a broker resolves it under policy, for the duration of the
execution, and injects only what was asked for.

```
execution → requests handle "github"
          → policy: is "github" in this execution's ExecutionPolicy.secrets?
          → broker resolves it for this Space only
          → injected into the runner's environment for this run
          → audit row: handle + outcome, never the value
```

Work required before this is real:

1. `@polyth/credential-vault` becomes Space-owned (`spaceStorage(ctx)` instead of
   `dataDir`), with the same migration shape as projects/sessions.
2. The same for SSH connections, MCP secrets, provider credentials, Home
   Assistant tokens, and any `POLYTH_*` env passthrough.
3. A broker service between the safe and the executor, with the audit hook
   already present in `@polyth/tenancy` (`AUDIT.secretResolved`).

Until then, a Hobby Space *can* reach Work's credentials on the same server.
That is the single most important open gap and is why `server-trusted` and
above are not yet supportable.

**Current state (source-inspected, unit-tested).** Credential Vault stores are
Space-owned (`spaceStorage(ctx).path("secure-safe")`), with personal
partitions beside them (§14.4). Opaque package secrets are partitioned per
package: `bindPackageServices` hands each package a Vault (`secure-safe`,
`secure-safe.spaces`) whose opaque keys are stored as `pkg.<packageId>:<key>`,
so a package cannot read, overwrite or delete another's opaque key even by
guessing it, and never sees person stores (`forPerson`). Host code with the
unbound service keeps raw access. Keys written before the namespace move on
the first open of a Space store (`google:`, `gitlab:`, `task-trackers:` to
their package; `pkgconn:` to `plugins`); the move is idempotent and never
overwrites a namespaced value. Keys no package claims stay host-only and are
logged once per store by count. A rollback to a build without the namespace
no longer finds the moved keys (affected connections must be reconnected).
Services are bound exactly once, by the host where it builds a package host
(`hostFor`, and `managedPackageServices` for managed entries, in
`packages/server/src/indexCore.ts`). The package loader and the package manager
only check that the services they hand on are bound to that package's id and
reject unbound or foreign ones; binding a bound registry again throws, and no
bound view leads back to the unbound registry. Builds from 2026-10-15 to
2026-10-30 bound twice and nested the namespace (`pkg.<id>:pkg.<id>:<key>`), so
they could not see migrated keys, e.g. a Space's Google client secret, which
made Google's token exchange fail with `invalid_request`. The same first-open
migration collapses a repeated namespace to one; the repeated value wins
because it is the newer write.

---

## 5. Execution plane (Phases 2–5)

### The principle

> A Runner is disposable compute. A Space is persistent state.

Never "one user = one forever-running container". Instead:

```
Space (persistent)                Session / task
├── repositories                        ↓
├── worktrees                    ephemeral runner
├── attachments                         ↓
└── environment            mount the required persistent state
                                        ↓
                                     execute
                                        ↓
                              persist the result
                                        ↓
                              destroy the runner
```

This composes with the existing worktree flow, and deliberately does not couple
worktree lifetime to runner lifetime:

```
main repo → session starts in an isolated worktree → runner operates on it
→ task completes → user merges → session returns to the source branch context
→ worktree removed → runner destroyed
```

The worktree may outlive many runners, and a runner may be recycled between
tasks on the same worktree.

### The contract

`ExecutionBackend` (in `@polyth/contracts`) is the narrow protocol between the
control plane and the execution plane:

```ts
acquire(ctx, spec) → RunnerHandle
exec(ctx, runner, command) → ExecResult
release(ctx, runner)
list(ctx) → RunnerHandle[]
```

Every method takes an already-validated `SpaceContext`; a backend never
resolves tenancy itself. Backends: `host` (today's behavior), `container`,
`sandboxed-container`, `microvm`, `remote-worker`. Selecting one is a function
of the deployment profile, so session and project APIs never change.

### Control plane vs execution plane

```
CONTROL PLANE                          EXECUTION PLANE
auth, users, spaces, memberships       runner
project + session metadata             sandbox
package registry, scheduler            agent process
secrets broker, policies               shell, browser
usage, quotas, audit                   user code
        │
        └── narrow authenticated execution protocol ──▶
```

A compromised runner must not reach the Polyth database, server credentials,
other tenants, the control plane, or the host filesystem. Workers must not need
database access — which is why the contract above passes *values*, not handles
to Polyth services.

### Network policy for hosted execution

Blanket `network: none` is wrong for coding agents (npm, pip, cargo, git, model
APIs all need egress). The eventual default:

```
public internet          allow
private host networks    deny
Polyth control network   deny except the narrow runner API
other tenants            deny
cloud instance metadata  deny
inbound                  deny
```

An exposed port is published through an authenticated tunnel — which is what
Polyth Link already is — rather than bound to a public host port.

---

## 6. Packages: trusted platform vs tenant

Polyth's "everything is a package" model stays. Multi-tenancy splits it in two:

**Trusted platform package** — installed by the server administrator, part of
the trusted computing base, may execute in-process. Every package in
`packages/` today is one of these.

**Tenant package** — installed by a Space. Must not become arbitrary
server-side code with control-plane privileges. It should eventually run under
sandbox semantics against a mediated context:

```
ctx.files  ctx.process  ctx.browser  ctx.network  ctx.secrets  ctx.storage  ctx.events
```

instead of raw `fs`, `child_process`, `process.env`, and sockets.

Migration path (do not break the current package API):

1. identify unsafe assumptions — done for storage (`storageDir` vs
   `spaceStorage`); still to do for process, network, and secrets;
2. introduce the mediated surfaces alongside the current ones;
3. move each package's tenant state to `spaceStorage(ctx)`;
4. flip `allowsTenantPackagesInControlPlane` off for the remaining profiles.

---

## 7. Session recovery

Tenancy must be part of recovery identity: never restore a runtime or session
from a session id alone.

Today the boot migration adopts every projection before the gateway serves a
request, so a recovered session always has an owner by the time anything can
ask for it. Runner recovery metadata (`RunnerHandle`) carries
`{ spaceId, ownerKind, ownerId, backend, state }` so a Phase 3 executor can
re-validate ownership rather than trusting a runner id. The remaining work is
to assert the tenant *inside* `recoverExecutingOperations` and
`recoverRestartInterruptedTurns`, so a corrupted or hand-edited database cannot
resurrect a session under the wrong Space.

---

## 8. Quotas and audit

**Quotas** are per Space and enforced server-/executor-side, never in the UI.
Dimensions to track: concurrent agents, CPU, RAM, disk, active worktrees,
execution duration, browser sessions, network transfer, model tokens, provider
cost, storage, package storage. Phase 1 ships one: a per-user Space count in
`spaceRoutes`.

**Audit** is Space-scoped and append-only (`<space>/audit/<date>.jsonl`).
Recorded today: space created / renamed / deleted / switched, member added /
removed. Reserved for later: secret use, runner create/destroy, port exposure,
package install, integration change, permission change, destructive operations.
Values are never recorded — a `redact()` pass replaces anything whose key reads
like a credential.

---

## 9. Cross-space operations

Default: **forbidden**, with no implicit references anywhere. Later, as
explicit operations only: move project to Space, duplicate project to Space,
export/import session, share artifact, share package configuration. Each must
name both Spaces and check membership in both.

---

## 10. Testing

- `packages/tenancy/test/tenancy.test.ts` — registry, roles, remembered
  selections, context resolution, path traversal + symlink escape, migration,
  deployment profile.
- `packages/server/test/spaceIsolation.test.ts` — **one user, two Spaces**
  (the case that catches authorization-by-`userId`), plus two users, reads,
  mutations, deletes, search, labels, the HTTP gateway, and WebSocket fan-out
  (projections, events, notifications).
- `packages/server/test/spaceMigration.test.ts` — a real pre-tenancy
  installation on disk boots into Personal, idempotently.
- `apps/web/test/spaces.test.ts` — the client mirrors the server and never
  picks a Space itself.
- `packages/server/test/sessionPeople.test.ts` — **two people, one Space, one
  chat**: forged authors are ignored, queued turns run as their author,
  drafts/pins/unread are per person in reads and live fan-out, forks and
  delegated children; `packages/session/test/personState.test.ts` for the
  v21 store.

Every isolation assertion uses **known-valid ids from the other Space**, not
guessed ones: guessing only proves the id space is large.

---

## 11. Account guardrails (household accounts)

Status: **implemented** for canonical identity mode. Use case: a less technical
household member uses the same server; the owner decides which models she may
use and keeps risky execution away from her, while some chats are shared.

**Sharing is Spaces, not a new ACL.** Recommended layout: the owner's Personal
Space (owner only), a shared Space where both are members (shared chats are
read and written by both), and optionally a Space for her own chats. A Space is
the existing security boundary, so no per-session visibility or WS fan-out
change was needed.

**Guardrails** (`AccountGuardrails` in `@polyth/contracts`) are set only by the
instance owner, never on an instance owner, in Settings → Users, stored in the
control plane (`account_guardrails`, migration v8; NULL row = removed, revision
monotonic, audited as `identity.guardrails-*`), and served by
`GET|POST /api/auth/accounts/:id/guardrails`; `GET /api/auth/me` returns the
caller's own `guardrails`. They are enforced server-side at these seams:

| Seam | Effect | Owner |
|---|---|---|
| Principal | `ui-session` / `paired-device` carry `accountGrants`, re-read on every resolution and WS revalidation | `packages/server/src/canonicalAuth.ts` |
| HTTP/WS reachability | the paired-device default-deny route table (`CORE_REMOTE_ACCESS` + package `remoteAccess`) applies to every `/api`, `/internal`, `/debug`, `/metrics` path; capability checks honour the ceiling | `httpCore.ts`, `remotePolicy.ts`, `principalAllowsRemoteCapability` |
| Space role | capped at `member` (no member/package/Space-integration administration) | `canonicalSpaces.ts` |
| Models | catalog routes return only allowed models; explicit model/harness choices must be on the allowlist (first entry is the default for new chats; empty = the owner's project/harness defaults, no explicit choice) | `accountGuardrails.ts` |
| Sessions | no composer shell, no Auto-Approve or Full access (only `off`/`inherit` pass), no "always" replies, "once" only with `approvals: "once"`, no native-session import | `accountGuardrails.ts` (outermost session facade) |
| Guarded Space | a Space with any guarded member ignores standing allow rules, Auto-Approve and package-tool auto-approve: agents ask a human every time; deny rules still win | `guardedPermissions`, `sessions.ts` `guardedSpace`, `indexCore.ts` package-tool authorize |

The web UI only mirrors this (hidden shell/Auto-Approve/"always", owner-only
settings, single-model picker); hiding is never the enforcement.

Known limits:

- Legacy (non-canonical) auth mode has no guardrails.
- An agent subtask approved by a human in a guarded Space may select its own
  model; approval, not the allowlist, gates that.
- Shared chats record who wrote each message (§14); a guarded account's
  messages carry its author like anyone else's.
- Host execution is still unsandboxed (§5): guardrails decide who may approve
  agent actions, not what an approved action can reach.

## 12. Account limits (projects, harnesses, daily use)

Status: **implemented** for canonical identity mode. Independent of §11: any
account except an instance owner may be limited, protected, both or neither.
`AccountLimits` (`@polyth/contracts`) has four nullable fields — `projects`,
`harnesses` (ordered; the first is the default for chats that do not pin one),
`messagesPerDay`, `chatsPerDay`; `null` means no limit and all-null is stored as
removed. Set only by the instance owner (elevated) in Settings → Users, stored
in the control plane (`account_limits` + per-day counters `account_usage`,
migration v9; NULL row = removed, revision monotonic, audited as
`identity.limits-*`), served by `GET|POST /api/auth/accounts/:id/limits`
(`usage` = today's counts, server-local day); `/api/auth/me` and the owner's
account list carry `limits`/`usage`. The same change adds owner-only
`POST /api/auth/accounts/:id/profile` (rename) and `/password` (reset; ends the
account's sessions, refused for instance owners and IdP-managed accounts).

| Seam | Effect | Owner |
|---|---|---|
| Canonical read policy | a project off the list is not readable, and neither is any resource under it (its sessions, including the account's own); every project/session/package route reads through it | `resourceAccess.ts` `projectAllowed`, wired in `canonicalSecurity.ts` |
| Listings that bypass per-resource reads | navigator `summaries` filtered; WS `projection`, `worktrees/changed`, `project-presentation/changed` fan-out skips hidden projects | `accountLimits.ts`, `ws.ts` |
| Projects | an account with a list cannot add/create/clone projects | `limitedProjectsForActor` |
| Harnesses | the list names shared harnesses; the account's own private logins (§13) are always allowed, other users' never. Create pins the first allowed harness when none is pinned; Auto or a disallowed pin is refused; a turn on a chat not pinned to an allowed harness is pinned first (to the harness it already runs on when allowed, so no switch); switch/resume checked; model catalogs drop models on other harnesses | `limitedSessionService`, `harnessAllowedFor`, `limitedCatalog` in `httpCore.ts` |
| Harness listings | the gateway mints `allowedHarnesses` into the request context per resolution; `/api/harnesses`, `/roster`, `/snapshots`, maintenance routes and each family's `/api/<package>/accounts` rows show only allowed shared harnesses plus the account's own logins (`harnessUsableByUser`) | `canonicalSpaces.ts`, `harness-runtime` `serverEntry.ts`/`accounts.ts` |
| New-chat route | the composer drops a remembered harness/model/agent pick or a pinned project default that is missing from the caller's `/roster` (nothing is rewritten) and quietly takes the harness of the first favorite, then recent, model the caller may use, else the first available one; the model falls back to a favorite, then a recent, then the first shown one. A pinned preview the server answers `harness not found` shows the first available harness instead of an error and drops the stored roster once. The chat is created on the harness the picker shows | `newChatDraftRoute`/`preferredVisibleHarness` (`executionDraft.ts`), `visibleFallbackModel` (`composer/discovery.ts`), `useVisibleHarnessIds` (`models` `runtimeCatalog.ts`) |
| Daily counts | `send` counts a message, `create`/`fork` a chat; over the cap → `limit-reached` (429, a refusal, `mutationOutcome: not-started`); a failed operation is refunded; unlimited accounts are never counted | `accountLimits.ts`, identity `limits.consume/refund` |

Order: the limits facade sits inside the Protected mode facade, so a model
chosen under §11 is still harness-checked. The web client mirrors only the
"add project" control; hiding is never the enforcement.

Known limits:

- Legacy (non-canonical) auth mode has no limits.
- Agent-initiated work (Polyth MCP tools, delegated children) uses the same
  Space services, so it is limited exactly when its request resolves to the
  limited account. Which account those requests resolve to was not verified
  for this change; treat agent-created chats as possibly uncounted.
- Queued messages are counted when queued; a message removed from the queue is
  not refunded.
- Harness restriction cannot see a harness name the owner never enabled; the
  owner picks from the current Space's harness snapshots.

## 13. Account permissions (managing assistants)

Status: **implemented** for canonical identity mode (source-inspected and
unit/route-tested; not live-verified). Also covers per-person harness
profiles: private accounts, shared-account allowlists and each person's
default harness. Installation-wide authority the instance owner hands to
another account, default-deny. The vocabulary is
`AccountPermission` (`@polyth/contracts`): `harnesses.manage` ("Can manage
assistants") and `harnesses.personal` ("Can add own harness accounts"). An
instance owner implicitly holds every permission and cannot be given any.
Set only by the elevated instance owner in Settings → Users → *account* →
Assistants (applies immediately), stored in the control plane
(`account_permissions`, append-only migration after `cliAccess`; empty list =
none, revision monotonic, audited as `identity.permissions-updated`), served by
`GET|POST /api/auth/accounts/:id/permissions`; `/api/auth/me` and the owner's
account list carry `permissions`.

The canonical Space gateway mints `harnessManager` and `harnessPersonal` on
every context from that row (active principal only; a guarded account under
§11 never gets either), next to `instanceOwner`. Request input can never set
them. `@polyth/contracts/instance-authority` has
`has|requireHarnessManagerAuthority` (instance owner, `harnessManager`, or the
pre-canonical single `local-user`) and `has|requirePersonalHarnessAuthority`
(those, or `harnessPersonal`).

| Seam | Effect | Owner |
|---|---|---|
| Harness on/off and order | `PUT /api/harnesses/preferences` (the calling Space's routing preferences) requires manager authority; `GET /api/harnesses/access` → `{manage, personal}` tells the UI | `harness-runtime` `serverEntry.ts` |
| Harness title and color | `PUT /api/harnesses/<id>/appearance` (the calling Space's presentation preference) requires the same manager authority | `harness-runtime` `serverEntry.ts` |
| Own private accounts | add/rename/remove (`POST`, `PATCH`/`DELETE /api/<package>/accounts[/:id]`) need personal authority and a `local-trusted` deployment (`allowsInteractiveProviderAuth`); per-user cap 4, family cap 16. An account added by anyone but the instance owner stores `ownerUserId` and is private; the owner adds a shared one unless it sends `private: true`. A holder of only `harnesses.personal` (or a manager) changes only its own private accounts: shared ones answer 403, other people's 404 | `harness-runtime` `accounts.ts` |
| Shared account allowlists | `PUT /api/<package>/accounts/:id/access` `{allowedUserIds, allowedSpaceIds}` (null/[] = everyone/every Space) by the owner or a manager only, shared accounts only (private → 400), any deployment (it only narrows). Stored on the account record, read live by the descriptor (`accountAllowedUserIds`/`accountAllowedSpaceIds`); a restricted account gets `autoSelect: false`. A malformed stored list hides the account rather than sharing it | `accounts.ts` |
| Visibility | the account list shows the owner every account, a manager every shared one (with its lists, `accessEditable`), everyone else their own private ones and the shared ones usable by them in the current Space (`usable`, `mine`, `canAddShared`, `canEditAccess` flags). `/api/harnesses`, roster, snapshots, system prompt, controls, skills and maintenance routes show only harnesses usable by the caller in the current Space | `accounts.ts`, `serverEntry.ts` |
| Use | one rule, `harnessUsableByUser(descriptor, userId, allowedHarnesses, spaceId)`: a private account only for its owner; a shared one when both allowlists admit the person and Space and the §12 list names it (strictest wins). Create/send/resume/switch/restart that would run on anything else is refused (`forbidden`); model and agent catalogs drop its entries. The map comes from the registry's descriptors per call (`harnessAccessOf`) | `accountPermissions.ts` (`privateHarnessSessionService`, `privateHarnessCatalog`), `accountLimits.ts` `harnessAllowedFor`, wired in `spaceScope.ts` / `httpCore.ts` |
| Person default | `GET|PUT /api/harnesses/default` `{harnessId: string\|null}` → `PersonHarnessDefaultDto {harnessId, usable}`, the caller's own choice, stored in `host.people.storage(userId, "harness-runtime")/default-harness.json` (never a Space or request field). Write requires a harness usable by the caller in the current Space and not turned off there; at use the same check runs again and an unusable choice is ignored, not deleted. A new chat that names no harness, model, agent profile, parent or native session is pinned to it (`personHarnessDefault.ts`, inside Protected mode, outside the limits facade), so the order is: explicit choice > Protected-mode allowlist > person default > §12 first entry > project/Space defaults. Auto is unchanged: private and restricted accounts keep `autoSelect: false` | `serverEntry.ts` `personDefaults`, service `harness.person-defaults`, `personHarnessDefault.ts` |
| Schedules | a run of a task with `ownerUserId` creates and sends through `host.personSpaceContext(ownerUserId, spaceId)`, so the owner's private account works and anyone else's is refused by the facade above; if the owner is no longer an active member the run fails with a recorded error before anything is created. Keep-alives follow the same rule (skipped while refused). Tasks without an owner keep the system context. A run's message keeps `via: "schedule"` | `packages/agents` `serverEntry.ts`, `sessionPeople.ts` `admittedAuthor` |
| Judges | a judge with actions records the signed-in person who last saved it (`ownerUserId`); it reads only chats that person can open and acts only through `host.personSpaceContext(ownerUserId, spaceId)` (send, approve, Auto-Approve, resume, plus a `manage` check before merging). An owner who left makes it read and do nothing. Only a person can save one. A judge's message keeps `via: "judge"`, and approvals are skipped in a Space that never answers automatically | `packages/judgment-judges` `serverEntry.ts`, `actions.ts` |
| Delegated children | `agent.spawn` already creates through the actor's context (§14.3), so a child spawned for one person cannot pin another person's private account | `sessionControlTool.ts` |
| Removed login reuse | a private account directory carries an owner marker; re-adding the same name restores a kept login only for the same user, anyone else gets a fresh directory | `accounts.ts` |

Known limits:

- Harness routing preferences remain per Space: a manager changes them for
  every member of a shared Space it is in.
- A harness's execution context is the Space's internal context, not the
  requesting user; account use is enforced at the actor's session facade and
  listings, not inside the registry.
- The allowlists apply to everyone, the instance owner included (it can edit
  them), and to system work: a system context matches no person, so an
  ownerless schedule cannot run on a person-restricted account.
- Only stored accounts carry allowlists; a family's default harness (the
  host's own login) is restricted only by §12 limits and Space routing.
- A schedule run as its owner starts chats with the owner's Space default
  audience (§14.3), usually private to the owner, instead of following the
  project like ownerless work.
- The person default applies only when the client omits harness, model and
  agent profile on create; a client that always sends its picker's choice
  bypasses it.
- Native plugin routes are not filtered by account ownership or allowlists.
- OpenCode per-person provider keys are out of scope (OpenCode provider
  configuration stays owner-only), as are per-person routing on/off
  preferences and per-Space enablement of private accounts.

## 14. People: profiles, authorship and session sharing

Status: **stages 1–3 and 5 implemented** (source-inspected and
unit/integration-tested; not live-verified against real providers or a running
installation). Stage 4 (administration: break-glass, offboarding, audit) is
**designed, not implemented**. The goal is
full differentiation between people who share one installation: each person
has their own chats, their own outside accounts (task trackers, GitHub,
Google), and sharing that both the person and an administrator control.

### 14.1 Model and decisions

Three layers, and the strictest one wins:

1. **Installation** — the instance owner (and accounts given admin
   permissions, §13) sets ceilings.
2. **Space** — a Space admin sets the sharing policy for its content.
3. **Person** — owns the chats they create, their connected accounts and
   credentials, their memory, and their own view of every chat they can read.

Decisions (2026-10-13, product owner):

| Question | Decision |
|---|---|
| Default visibility of a new chat in a shared Space | **Private** to its creator |
| Whose account an agent uses in an outside service | **The person who sent the message** the turn answers |
| Admin access to someone's private chat | **Break-glass**: audited, owner notified, time-limited |
| Who connected accounts belong to | **The person**, enabled per Space (a Work Space never silently gets a personal GitHub) |

### 14.2 Stage 1 — people in shared sessions (implemented)

| Seam | Behavior | Owner |
|---|---|---|
| Person | `SessionPerson {userId, name?, via?}` is minted only from an authenticated Space context; a system context (control socket, background package work) is nobody | `contextPerson` in `packages/server/src/sessionPeople.ts` |
| Authorship | `SessionService.send(id, input, admission?)`: the Space facade sets `admission.author` from the signed-in person; the base service discards any `input.author` and writes the admitted author on `user/message`, `queue/enqueued` and `delivery/steered`. The client admission fingerprint excludes it | `spaceScope.ts`, `sessions.ts` |
| Acting for someone | Trusted server code on a system context may act for a member (a schedule for its owner, `via: "schedule"`), but only while that person is an active member of the Space; otherwise the send is refused (`forbidden`, not started) | `admittedAuthor` |
| Queue | `session_queue.author` (store v21); dispatch admits a queued turn as whoever queued it, never as whoever freed the queue | `packages/session`, `sessions.ts` dispatcher |
| Acting person | `SessionProjection.actor` is the author of the latest admitted human message, written before the runtime sees the prompt. Agent/system prompts never change it; a delegated child created during a turn inherits the parent's (`via: "delegation"`); a fork carries none | `sessions.ts` |
| Tools | The tool bridge resolves `ToolExecutionContext.actorUserId` from the session's actor at call time. Absent means system work, which must never borrow a member's account | `agentTools.ts`, `indexCore.ts` |
| Schedules | `ScheduleTask.ownerUserId` is set from the signed-in creator (never from a request body, never edited); runs send with `scheduleTurnAdmission(task)`. Routes filter by owner (`scheduleTaskAccess`): a member lists, reads and changes only their own agents; a Space admin also lists others' as metadata (no prompt, notebook, runs or context) and may only pause, resume, stop or delete them; ownerless legacy agents are admins' only; loop-file agents and server work are unchanged. The `polyth_agents` agent tool acts only for the turn's person (`actorUserId` resolved through `personSpaceContext`; a turn with no person, a viewer or a non-member is refused), owns what it creates by that person, and applies the same `scheduleTaskAccess` rules; it has no auto-approval | `packages/agents` `serverEntry.ts`, `agentTool.ts` |
| Per-person view | `session_person_state(session_id, user_id, read_seq, draft, draft_updated_at, pin_position)` (store v21). Drafts, read cursors and pins written through the Space facade are the caller's own; folders and labels stay shared Space organization | `packages/session`, `sessions.ts` `saveDraft`/`markRead`/`organize` |
| Reads | snapshot, list, sync and summaries are personalized per person in the facade; live projection fan-out personalizes per socket, once per person and synchronously so broadcasts never reorder | `spaceScope.ts`, `ws.ts` via `SpaceGateway.people` |
| Composer recall | Space/session prompt history skips prompts another person wrote | `listPromptHistory({personId})` |
| UI | A prompt someone else wrote shows their name, quiet, above the bubble, and its article label names them; one's own prompts are unlabeled | `Timeline.tsx`, `.msg-author` |

Upgrade semantics: a NULL person column means "never chosen", so pre-v21
shared state keeps applying until a person makes their own choice. The shared
read cursor (`session_read`) applies to everyone without their own; a shared
pin is everyone's default until they pin or unpin; a pre-v21 draft is shown
only to the session's canonical owner (everyone in legacy single-user mode)
and is cleared from the projection when the owner first saves their own. A
fork never copies the source's draft, pin or actor.

Known limits of stage 1:

- Messages written before this change, composer shell commands and queue
  edits carry no author (an edit keeps the original author). Unauthored
  prompts stay in everyone's composer recall.
- Legacy (non-canonical) auth has one person, who owns every pre-v21 draft.
- A message steered into a running turn records its author but does not
  change the actor: that turn keeps acting for whoever started it. A queued
  message changes the actor only when its own turn is admitted.

### 14.3 Stage 2 — session sharing (implemented)

Access lives in the canonical resource registry (control plane v12); every
session read, write and broadcast goes through it.

| Seam | Behavior | Owner |
|---|---|---|
| Audience | A session resource's `visibility`: `private` (owner only, grants ignored), `restricted` (owner and grantees), `space` (every member, plus grants above that), or `inherit` (its access parent, else its project — `space`, or `private` for a member's personal project). The API speaks `private`/`restricted`/`space`; a top-level chat opened to the Space is stored as `inherit` so it keeps following its project | `resourceAccess.ts` |
| Levels | `view` reads (and keeps a person's own draft, read cursor, pin and forks); `collaborate` also sends, steers, answers requests, edits the queue, rewinds, runs composer shell and switches harness; `manage` also renames, archives, restores, deletes, shares and changes auto-accept, memory policy and the workspace. The owner manages; on a Space-wide chat Space admins manage, members collaborate and viewers view; a grant can raise one person. A viewer membership never acts above `view`. Ownership and grants never outlive membership, and removing a member deletes their grants in that Space. Space admins get **no** access to private chats (break-glass is stage 4) | `resourceAccess.ts`, tenancy `removeMember` |
| Grants | `resource_grants(resource_id, principal_id, access, granted_by, …, expires_at_ms, revision)`. `share()` replaces the people list atomically, only names active human members other than the owner, bumps `access_revision` (the `expectedRevision` token) and audits `resource.shared`; making a chat private removes every grant. `expires_at_ms` is honored but not settable yet (stage 4). Narrowing (`private`/`restricted`) a chat a system principal owns (server work: workflows, schedules, delegated children) makes the acting member its owner (`resource.owner-adopted`), since a system owner would leave nobody able to open it; boot (`reclaimUnreachable`) hands rows narrowed before that rule back to the member who last shared them | `resourceSharing.ts` |
| New chats | A chat a person starts, forks or imports takes the Space default (private unless an admin chose `space`), whatever the member count, so inviting someone later never exposes earlier chats. Chats server work starts (schedules, system contexts) and rows that predate canonical resources keep `inherit`. Package routes that start a chat for the requester (isolated worktree chats, git conflict hand-off) must create through `host.forSpace(rc.space).sessions`, never the host-wide `host.sessions` (system work) | `sessionResourceAuthority.ts`, `defaultSessionVisibility`, `packages/git/src/serverEntry.ts` |
| Subagents | A delegated child records its parent chat as `access_parent_id` (set once, same Space, no cycles) and follows the parent's audience and levels, so narrowing a chat closes its subagents' transcripts; it is shared through its parent. Starting one needs `collaborate` on the parent. Boot reconciliation adopts pre-sharing subagents (`accessParentsAdopted`); a fork (`session/forked`) is a separate chat owned by whoever forked it, and its notifications go to them | `resourceStartupReconciliation.ts`, `indexCore.ts` |
| Method gate | One table maps every session method to a level, including `replayPage`, `activate` and both sessions of `replyDelegatedPermission`. A chat the caller cannot open answers `not-found`; one they can open at too low a level answers `forbidden` | `sessionResourceAccess.ts` `METHOD_ACCESS` |
| Reads | list, sync and snapshot return only openable chats, each with the reader's `SessionProjection.sharing` view (audience, inherited, access, owner when not the reader, `shared` = someone else can open it). The navigator's paged summaries skip unopenable rows and refill from up to 8 store pages, keeping `next` valid. Search intersects with that list; Space-wide prompt recall skips chats the reader cannot open | `sessionSharing.ts` `rowsForReader`, `routes/promptHistory.ts` |
| Live fan-out | Projection broadcasts are filtered and decorated per socket person, once per person and synchronously. A sharing change sends each reader its new row; a person who could open it before and no longer can gets `{type: "session/removed"}` and their subscription to it ends. Nobody else learns the chat exists. Subscribing to an unopenable or deleted chat answers `session/removed` instead of a resync loop | `ws.ts` `sessionAccessChanged` |
| Agents | The `polyth` tool acts for the session's actor through `host.personSpaceContext(actor, space)`: an agent sees and changes only what the person who sent the turn could, and refuses when that person left the Space. A turn no person started keeps the provisioned context | `harness-runtime` `sessionControlTool.ts` |
| Space policy | `space_sharing_policies`: default audience (`private`/`space`), whether chats may be opened to the whole Space, whether members who are not admins may share, and the highest access they may give (default: private, allowed, yes, `manage`). Admins set it; it governs new chats and new sharing, never existing access. Members who may not share can still narrow what they shared | `resourceSharing.ts`, `sessionSharing.ts` |
| API | `GET/PUT /api/sessions/:id/sharing` (`SessionSharingDto`/`SessionSharingUpdate`; paired devices: read / control) and `GET/PUT /api/sharing/policy` (paired devices may read; changing it stays local, like membership) | `routes/sharing.ts`, `remotePolicy.ts` |
| UI | Share dialog, navigator marker, owner in the header, manage-only row actions, a people-only composer for viewers (§14.8) and the Space policy in Settings → Users; contract in [UI §3 "Shared chats: who can open a chat"](../dev/ui.md) | `apps/web` `ShareSessionDialog.tsx`, `sessionSharing.ts` |

Known limits of stage 2:

- A chat opened to the Space gives members `collaborate`; there is no
  Space-wide `view`-only audience. Share with named people for that.
- Turn notifications still go to the chat's creator (a fork's to whoever
  forked it), not to whoever started the turn. People-message notifications
  (§14.8) go to the people they concern.
- Package routes that read a session by id are protected where they resolve it
  through `host.forSpace(rc.space)`, the documented pattern; packages' system
  services (`host.sessions`, `host.store`) still see the whole Space.
- Workflows and ownerless schedules run as server work, so the chats they
  start follow their project (stage 5 gives those stores owners). A schedule
  with an owner runs as that person (§13), so its chats take their default
  audience.
- Account-limit changes do not push removals to open sockets; the next read
  applies them.

### 14.4 Stage 3 — personal connected accounts (implemented)

- **Profile → Accounts**: each person connects GitHub/GitLab (OAuth or token,
  plus commit name/email), Jira/Trello/Linear and Google. Secrets live in a
  person-owned Credential Vault partition; metadata in person-owned storage.
- **Per-Space enablement**: an account works in a Space only after its owner
  turns it on there. Space admins may still connect a shared *service
  account*.
- **Resolution for agent tools** (uses stage 1's `actorUserId`): the acting
  person's account enabled in this Space → the Space service account, only if
  the Space policy lets agents use it → refuse with "connect your account".
  Never another member's account. Task-tracker personal connections move from
  per-(Space, person) to per-person + enablement; Google accounts become
  person-owned.
- **Git** (implemented for Git operations Polyth performs; source-inspected
  and unit-tested, not live-verified): commit author and transport
  credentials come from the acting person, passed to each Git child alone
  (`-c user.name/-c user.email` plus committer env via
  `withGitCommitIdentity`; a per-run origin-scoped credential helper via
  `withGitTransportAuth`), never written to `git config --local`.
  - *Acting person*: the signed-in member for a UI request; for isolation
    merge/snapshot/push/resolve the session's `actor` while they are a member,
    else the person who asked; pure system work has none. Isolation *push*
    credentials are always the asking person's (else the actor's, as agent
    work), so clicking push on someone else's chat never uses their account.
  - *Identity*: the person's Git profile (`people/<userId>/packages/git/profile.json`,
    `GET/PUT/DELETE /api/git/profile`, `PersonGitProfileDto`, any member, own
    profile only). The instance owner on `local-trusted` commits as the
    project's Git identity when one applies (Settings → Source control /
    Project settings → Git identity: the project's own, else the default for
    all projects, host-matched against `origin`), else their profile, else the
    checkout/global config; everyone else without a profile is refused
    (`git-identity-required`, 409, `mutationOutcome: not-started`, "Set your
    git name and email in Profile → Git"), and their commits run with
    `commit.gpgsign=false`/`tag.gpgsign=false` so they never sign with the
    checkout's (owner's) signing key. System work uses the project's Git
    identity's author if one applies, else the checkout config.
  - *Transport* (`actorTransportAuth`): the person's own GitHub/GitLab
    account turned on in this Space → the project's bound Space (service)
    account — for UI requests whenever it exists, for agent/system work only
    under `servicePolicy(space, "git").agentsMayUseService`
    (`GET/PUT /api/git/service-policy`, admin writes) → the host's helpers,
    `gh` logins, `glab` and `~/.ssh` only for the instance owner on
    `local-trusted` → refused (`git-account-required`, 409, not started; SSH
    remotes and unattributable URLs are refused for everyone else). Providers
    tag accounts `personal`/`service`/`installation`
    (`SourceControlHostingAccount.owner`); only service accounts bind to
    projects. `/api/git/identity` writes, `credential.<origin>.username` and
    `core.sshCommand` are owner-only.
  - *GitHub API*: the person's own token (`/api/github/accounts`, person
    vault) reaches one `gh` child as `GH_TOKEN`/`GH_ENTERPRISE_TOKEN` with an
    empty `GH_CONFIG_DIR`; the host's `gh` only for the instance owner on
    `local-trusted`; else refused. *GitLab*: the person's own PAT
    (`/api/gitlab/me/accounts`) → the project's Space account; `glab` logins
    are owner-only. *Who is signed in* (the user-menu avatar's
    `GET /api/github/status?passive=true` and the Git view's
    `/api/github/context`) follows the same rule but needs no repository
    lookup: one `gh api user` per Space + person + account, never per project
    (`userCache.ts`). It is kept for 10 minutes and refreshed behind the
    answer; a failed refresh keeps the last good answer (24 h at most) unless
    `gh` itself reports no account; concurrent asks share one call; disabling
    the package forgets it. A live `/api/github/status` feeds it too. The shell
    asks per project, once more after an empty answer and when a backgrounded
    window returns (`apps/web/src/profileAccount.ts`).
  - Not covered: Git that agents run in their own shells and Terminal use
    the host's default identity and logins (one shared harness process per
    chat, §14.7). Package installs and updates, which may fetch private
    archives through the shared GitHub service's host `gh`, are instance-owner
    actions: the routes assert it and the plugins package asserts it again
    where the host credential is used (`ownerRepositoryDownloader`; the
    owner's auto-updates count). Walkthrough pull-request capture also uses
    the host `gh`: the shared GitHub service has no per-person entry point yet
    (a package's `host.people` reads only its own vault), so it is refused for
    everyone but the instance owner on local-trusted (`git-account-required`).

**Implemented: foundation** (source-inspected and unit-tested; Google is its
first connected-account user, below, and harness-runtime stores each
person's default harness in it, §13). The host gives every server package
`host.people` (`PeopleHost` in `@polyth/plugins`; built by
`packages/server/src/people.ts`), bound to that package's id — any other
`packageId` argument is `forbidden`:

| Seam | Behavior |
|---|---|
| `storage(userId, packageId)` | `<dataDir>/people/<userId>/packages/<packageId>`, outside every Space, created on demand; `path()` refuses traversal, absolute paths and symlink escape (`resolveInside`). User ids: leading alphanumeric, then `[A-Za-z0-9_-]`, so `system:*` principals are not people |
| `vault(userId, packageId)` | Opaque secrets in `people/<userId>/vault/<packageId>`, a separate physical Credential Vault store per (person, package), unreachable from the package's storage root. Stored exactly like the Space vault: a `0600` JSON file, **not encrypted at rest** |
| `enabled` / `setEnabled(userId, spaceId, packageId, connectionId, on)` | Per-Space enablement in `people/<userId>/connections.json`, never in the Space. Turning on requires active membership; turning off always works |
| `servicePolicy` / `setServicePolicy(spaceId, packageId, {agentsMayUseService})` | In `<space>/connected-accounts.json`; default off, unknown Space reads off. Admin-only write is the calling route's job |
| `isMember(userId, spaceId)` | Active membership from the tenancy store |
| `resolveConnectionOwner(...)` (`@polyth/plugins`, browser-safe `@polyth/plugins/people`) | Non-member actor → `not-a-member`; the actor's enabled connection → `personal`; else the service account for `person-ui` when one exists, for `agent` only under policy; else `connect-your-account`. No actor (`system`, or an agent turn nobody started) → service only under policy, else `service-not-allowed`. Never another person |

Removing someone from a Space deletes nothing: their enablement for it stays
on disk but is ignored, because `isMember` fails. Deleting an identity account
(`DELETE /api/auth/accounts/:id` → `onAccountRemoved`) deletes
`people/<userId>` — storage, secrets and enablement — and drops the cached
vault, so a recreated account with the same id starts empty.

**Google accounts are person-owned** (`packages/google`, source-inspected and
unit-tested, live Google not exercised): members connect their own account in
Settings → Google, turned on per Space; existing Space accounts stay as admin-managed service accounts
(no migration); agent tools pick the acting person's enabled accounts, else
service accounts under the Space policy, else refuse. Tool *visibility*
follows the session's acting person too: the server puts the actor into the
capability resolve context (`HarnessContext.actorUserId`, read when the
session's runtime is built), and Google offers only tools an account that
person may use can serve; a runtime shared across sessions has no actor and
gets the Space-wide set. The list is minted per running session, so a new
actor mid-chat sees the list minted earlier and the call refuses. Details,
routes and limits: [`packages/google/README.md`](../../packages/google/README.md).
Git, GitHub and GitLab use the foundation too (Git bullet above), as do
task-tracker accounts ([`packages/task-trackers/README.md`](../../packages/task-trackers/README.md)).
The person's Git identity, GitHub/GitLab accounts and the Space service-account
policy are edited in Git settings ([UI contract](../dev/ui.md)); Google and
task trackers have their own settings pages. Not yet: one combined Profile →
Accounts page, and the 409 refusals carry their `reason` only in the message
text the client matches.

**Personal credentials** (Credential Vault, source-inspected and
unit/integration-tested; not live-verified):

- *Storage*: the person's own entries live in the people host's (person,
  `secure-safe`) store, `people/<userId>/vault/secure-safe`
  (`PeopleHost.credentialVault`), deleted with the account. Space entries stay
  in the Space store and stay admin-managed.
- *Routes*: `/api/secure-safe/personal[/:id]` lists/creates/rotates/deletes
  only the signed-in person's own entries (owner = `rc.space.userId`, never
  request input; admins included). `GET /api/secure-safe/access` reports
  `canManageSpace` and whether a personal partition exists. System
  principals have none.
- *Resolution*: `SecureSafeExecutionRequest.actorUserId` /
  `SecureSafeCredentialUseRequest.actorUserId` resolve the actor's own entry
  first, then the Space's, per handle; only a missing handle falls through.
  Only an active member of the Space has a partition there, so another
  member's or a foreign Space's entries never resolve; no actor (system work)
  means Space entries only. The composer shell passes the signed-in person
  (the Space facade injects it; a caller cannot name someone else).
  Redaction covers the Space's values plus the signed-in person's own.
- *Request flow*: the Space facade picks where a saved request lands
  (`secretSavePartition`): the person's own partition by default and in a
  chat private to them; the Space only when a Space admin picks it (a
  non-admin asking is refused), or for an admin's shared chat with no
  explicit pick. The value still enters only through the protected form.
- *Agent list tool*: the actor's own handles (`partition: "personal"`) and
  the Space's; a Space handle the person's own entry shadows is omitted.
- *Browser fill-from-vault* looks handles up with the actor-aware,
  metadata-only `listFor(actorUserId)` and resolves with the turn's actor.
- *Not yet*: the request's `existing` flag checks the Space only.

### 14.5 Stage 4 — administration (designed)

- **Installation ceilings** (instance owner, or a new `sharing.manage`
  permission): e.g. no sharing for Protected accounts, no `space` visibility.
- **Break-glass**: an admin opens a private chat only through an explicit,
  reasoned, time-limited grant; it is audited and the owner is notified.
- **Offboarding**: removing a member immediately voids their grants and stops
  their accounts in that Space; their private chats move to a new owner the
  admin picks, or are archived; a running turn they started is stopped and
  their queued messages are dropped. Schedules they own already refuse to run
  (stage 1).
- **Audit**: share, grant, revoke, break-glass, ownership transfer and
  credential use, with the actor and never a value.

### 14.6 Stage 5 — remaining stores (implemented)

Memory, MCP servers, SSH connections, schedules, workflows and the packages
that hold one person's data each have an owner (a person or the Space).

| Store | Owner and behavior |
|---|---|
| Workflows | A run acts for the person who started it (`launchers` beside the run in `workflows.json`); every unit goes through `host.personSpaceContext(launcher)`, refused before any child exists if they left. A retry acts for whoever asks (a system retry keeps the launcher). [`packages/workflow/README.md`](../../packages/workflow/README.md) |
| Personal coach, markets | Per (person, Space) in `host.people.storage`; the pre-person Space data moves to the first Space owner who opens it. Agent tools need an acting person |
| Handoff bundles | Visible to their creator and to whoever can open the source chat; legacy creatorless bundles to Space admins only |
| Slash commands, snippets | `user` scope is personal (person storage) and overrides `project` (shared, admin-written). Expansion on send runs as the message's author. Legacy `~/.config/polyth` files are copied once to the instance owner only |

"Remember" from a private chat defaulting to the person's memory is not built.
The memory store already has a `person` layer (owner = user id, reached only
through a server-minted layer grant; [memory](../dev/memory.md)), but nothing
grants it to a session yet.

**MCP servers have an owner** (source-inspected and unit/integration-tested;
not live-verified with a real harness). Owner: `packages/server/src/mcp.ts`;
routes in `routes/settings.ts`; Settings → MCP in `harness-runtime`.

| Seam | Behavior |
|---|---|
| Space servers | Global and project servers stay in the Space (`mcp.json` + `mcp-secrets.json`); existing ones remain Space servers, with no migration. Add, edit, remove, secret set, import, override and tool check need a Space admin (`roleAtLeast(role, "admin")`); members could write project servers before |
| Member view | `GET /api/mcp/servers` lists every Space server; for a non-admin each row is `redacted` and `canManage: false`: stdio `args` empty, HTTP URL cut to its origin. Command, env/header **names**, status and cached tools stay. Nobody, admins included, reads a secret value back |
| Personal servers | `/api/mcp/personal/servers` (CRUD, `:id/tools`, `:id/test`/`probe`) always act on the signed-in person's own servers (member or above; system contexts own none). Config in `host.people.storage(userId, "mcp")/servers.json`, secrets per server in `host.people.vault(userId, "mcp")`; deleting the account deletes both. No JSON import |
| Access | `GET /api/mcp/access` → `{canManageSpace, canManagePersonal}`; `/api/mcp` stays local-only for paired devices |
| Attachment rule | A person's enabled servers attach to a chat only when `privateSessionOwner(spaceId, sessionId)` names them (effective audience `private`; a delegated subagent answers for the chat it follows) and they are still an active member. A Space or project server with the same name wins |
| Seam | Capability provisioning: `opts.mcp.projection(space, project, sessionId)` is called with the session id **only** when the harness's target lifetime is `session` (one runtime per chat); personal rows become `session`-scope descriptors, which a project-scoped config also refuses. Evaluated at every runtime (re)launch (`beforeCreate` → `reconcile`) |
| Per harness | Claude (`--mcp-config` per session), Codex (`thread/start` config), ACP (`session/new`), Antigravity (per-session config): attached under the rule. OpenCode (one physical runtime per project/cwd serving many chats): **never** attached natively. Pi and Command Code have no native MCP. Every harness can still reach them through `polyth_mcp` |
| `polyth_mcp` | Lists Space/project servers plus personal ones only when the turn's actor (`ToolExecutionContext.actorUserId`) owns the private chat; `tools`/`inspect`/`call` re-check that on each call (after awaits too). A turn nobody started sees none. Calls use the owner's secrets and a person-owned authority file |
| Sharing | `SessionSharingDto.personalMcpDetachedOnShare` is set for the owner when they have an enabled personal server; the share dialog warns once a non-private audience is chosen |
| Re-provisioning | When a chat (or the chat it follows) stops being private and a reconcile handed its session runtime personal servers (`personalMcpLoaded`), the runtime is released through the idle-release gate (`releaseRuntimeIfIdle`: no turn, admission, lifecycle flight, transition, open request, queued prompt or uncertain operation) at any idle age; the next turn relaunches without them, keeping native continuity. While anything blocks that, the chat is re-provisioning: only its owner may send, queue, resume, compact or answer requests; anyone else gets `conflict` "this chat is being re-provisioned after sharing; try again in a moment". It retries on each idle projection and every 5 s, and ends when the chat is private again or its runtime is released another way (restart, harness switch). Owner: `personalMcpReprovision.ts`, gate in `sessionResourceAccess.ts` |

Limits:

- Re-provisioning state is in memory: a server restart forgets a waiting
  chat (runtimes it relaunches reconcile afresh). The owner's turn that is
  running when the chat is shared keeps the servers until it ends, and its
  output is visible to the new audience. Turns server work starts in the chat
  (schedules, workflows) do not pass the person gate. A Codex thread resumed
  later gets no MCP config at all from Polyth.
- A personal-server change reconciles only the Space where it was made; the
  person's chats in other Spaces pick it up on their next launch.
- Personal secrets share the vault's storage model: `0600`, not encrypted at
  rest. Execution is not contained per person (§14.7).

**SSH connections and Browser sessions: implemented** (source-inspected and
unit/route-tested; no live SSH host or live Chromium exercised).

| Seam | Behavior | Owner |
|---|---|---|
| SSH owner | `installation` (every connection that existed before, kept in the shared `ssh.json`) or `person` (id `u.<userId>.<uuid>`, stored in `host.people.storage(userId, "ssh")/connections.json`). The id names its owner, so server work needs no index | `packages/ssh` `index.ts` |
| SSH use | `sshConnectionUsable`: an installation connection is usable by the instance owner, people on `allowedUserIds` (any Space) and members of Spaces on `allowedSpaceIds` (there only); empty lists = owner only, a malformed list admits nobody else. A personal one only by its owner, in any Space they are a member of. Anything unusable answers `not-found` on every route: list, get, PATCH/DELETE, connect/disconnect/status/test, install, `harnesses`, `browse`, `POST /api/ssh/projects` | `index.ts`, `serverEntry.ts` |
| SSH management | Installation: the instance owner adds, edits, deletes, sets `PUT /api/ssh/connections/:id/access {allowedUserIds, allowedSpaceIds}`, disconnects and installs (an allowed member gets `forbidden`). Personal: `POST /api/ssh/connections` by a holder of `harnesses.personal` (or the owner with `owner: "person"`), managed by that person only. `GET` returns `{items, canAddShared, canAddPersonal}`; items carry `owner`, `mine`, `editable`, `keyUploaded` (personal) and the allowlists (instance owner only) | `serverEntry.ts` |
| SSH keys | A personal connection authenticates only with a key its owner uploads (`PUT /api/ssh/connections/:id/key {privateKey}`, unencrypted OpenSSH/PEM, ≤16 KB, stored `0600` at `keys/<id>` through the escape-proof `path()`; never returned). It dials with `-F /dev/null`, `IdentityAgent=none`, `IdentitiesOnly=yes` and its own `known_hosts`, so the server user's ssh_config aliases, agent and `~/.ssh` keys stay the instance owner's. `agent` mode and identity-file paths are refused there | `index.ts` |
| Remote harnesses | `resolveRemoteHarnessHost` asks the transport before launching: the session's acting person (`SessionProjection.actor`, through `host.personSpaceContext`) must be able to use the connection; with no actor (probes, a turn nobody started, an expired actor) the project binding decides: installation connections keep working, a personal one only while its owner is a member of the project's Space. The remote OpenCode runtime applies the same rule on every acquisition for a chat (warm or not) and on the binding at every (re)spawn | `harness-runtime` `remoteHost.ts`; `packages/server` `remoteOpenCodeAccess.ts` |
| Browser owner | A controlled-browser session records the person who opened it (route caller) or the person an agent turn acts for (`ToolExecutionContext.actorUserId`). Another person's browser is `not-found` on every `/api/browser/*` route and on the `browser/subscribe` WebSocket live view (re-checked per frame), including in a chat both can open; ownerless (server) browsers follow chat/project access as before, and over WebSocket a chat's browser needs access to that chat | `packages/browser` `index.ts` `ownerOf`, `serverEntry.ts`; `packages/server` `ws.ts` `canViewBrowser` |
| Browser agent | An agent turn uses and credential-fills only its acting person's tabs in the chat; a turn with no person uses only ownerless tabs and opens its own. Browser contexts are ephemeral (`newContext`, closed with the session), so no sign-in outlives the session and there is nothing to migrate | `agentTool.ts` |

Known limits:

- Projects are not filtered: a remote project bound to a connection someone
  cannot use still lists in a shared Space; its routes and harness launches
  answer `not-found`.
- The harness gate runs when a remote leg launches (for OpenCode, when a chat
  acquires the shared runtime). A leg already running for one person is not
  re-checked when another person sends the next turn in a shared chat.
- Personal connections need no per-Space enablement (§14.4): binding a
  project in a Space is the owner's explicit act there.
- Persistent sign-in profiles (Chromium user-data dirs) open only through
  the Browser package's manual-only profile driver (`browser.profiles`), and
  the caller supplies each directory. Chat Workspace, now an external
  package, kept them per person per Space when it lived in this repository.

Done so far (source-inspected and unit-tested, not live-verified): schedule
routes filter by owner (§14.2 Schedules row); memory recall is per principal
and Reflect proposals are per person, with the pre-person state kept as the
project's shared rules ([`packages/memory/README.md`](../../packages/memory/README.md)).

### 14.7 The execution boundary

Until the execution plane (§5) exists, every agent runs as the same OS user.
Stages 1–4 stop agents from being *handed* another person's credentials and
stop people from reading each other's chats through Polyth. An agent with a
shell can still read files on the host, including other people's worktrees
and the host's `gh`/`~/.ssh` logins. For agents in `local-trusted` and
`server-trusted`, person separation is policy, not containment; containment
needs per-person execution and no ambient host credentials.

Git is the concrete case: commits, merges and pushes that *Polyth* performs
use the acting person's identity and accounts (§14.4), but `git` an agent runs
in its own shell (and Terminal) runs in the one harness process the chat
shares, with the host's default Git identity, credential helpers, `gh` logins
and SSH keys. That is a deliberate scope decision, not an enforced boundary.

### 14.8 People talking in sessions (implemented)

Status: source-inspected, unit-tested and exercised on a local three-person
demo server (desktop browser); not device-verified on phones and not
live-verified on a production installation. Decisions: 2026-10-19, product
owner.

People can write to each other inside a chat without starting an agent turn,
and can start a chat that is only people ("conversation") and later hand
selected messages to an agent.

| Seam | Behavior | Owner |
|---|---|---|
| Event | `person/message {text, author, mentions[], carryToAgent?, replyToSeq?, clientOperationId?}` (`PersonMessageData`). It never starts, queues or steers a turn, never touches the runtime and is allowed while a turn runs. It is not in `MODEL_VISIBLE_TYPES`; old reducers ignore it | `packages/contracts` "people talking in a session", `sessions.ts` `postPersonMessage` |
| Author and mentions | The Space facade stamps the author like `send`. Mentions are deduplicated, capped (`PERSON_MESSAGE_MAX_MENTIONS`), exclude the author and keep only people who can open the chat (`sessionAudience`); a dropped id reveals nothing. `replyToSeq` must name a `person/message` of the same chat. A retry with the same `clientOperationId` returns the first result | `sessions.ts`, `sessionSharing.ts` |
| Access | `postPersonMessage`, `mentionCandidates` and `setPersonMute` need `view`; `carryToAgent: true` needs `collaborate`; `startSessionFromConversation` needs `collaborate` | `sessionResourceAccess.ts` `METHOD_ACCESS`, `personMessageLevel` |
| Next prompt | A carried message after the latest `user/message` joins the `<polyth-package-context>` block of the next prompt as "Message from {name}" (reference data, not instructions); `deriveMessages` treats it like `package/context`. Messages that are not carried never reach a model | `packages/session/src/packageContext.ts`, `deriveMessages` |
| Per person | `session_person_state.last_mention_seq` and `muted` (store v23). The reader's projection gets `muted` and `attention.mentions` (1 while a mention is newer than the reader's read cursor; `markRead` clears it). In a conversation, other people's messages count toward the reader's `attention.unread` | `packages/session` `setPersonMentionSeq`/`setPersonMute`/`unreadFor`, `sessionPeople.ts` |
| Notifications | Kind `mention` to each kept mentioned person; in a conversation also kind `message` to every other participant who can open it and has not muted it. Access is rechecked at delivery. The key is `person-message:<sessionId>:<seq>:<kind>`; the title names sender and chat ("Ann · Small talk", "Ann mentioned you · Small talk"), the body is the message, and the inbox row (`NotificationRecord`) also carries `author: {userId, name}` and `chat`, so a client draws the sender (colour, monogram) without parsing the title; agent kinds and rows written before 2026-10-20 have neither. Delivery reuses the one per-recipient leg (inbox row, WS, Web Push, native push). Web Push carries one tag per chat (`polyth-people-<sessionId>`) plus `chat`/`line`, so the service worker stacks a burst into one re-alerting notification ("Small talk · 3 new messages", the last five lines); people kinds push with `urgency: high` and a 12-hour TTL (task kinds keep 5 minutes, also on native push) | `indexCore.ts` `deliverToRecipient`/`deliverPersonMessage`, `push.ts`, `apps/web/sw.js` |
| Live fan-out | After the mention cursors are written, a message bumps the projection's `updatedAt` and republishes it, so every reader's socket gets the row personalized with their own `attention.unread` (others' messages, conversations only) and `attention.mentions`. Before 2026-10-20 nothing was republished, and people only saw a new message by opening the chat | `sessions.ts` `postPersonMessage` |
| Search | The FTS mirror indexes `person/message` text (role `user`) | store v23 triggers |
| Conversations | `purpose: "conversation"` sessions are created by `createConversation` without a runtime or native session: an owned, active canonical resource, `restricted` with `collaborate` grants for the participants, then the opening message mentioning them. Every runtime path refuses or skips them ("A conversation has no agent. Start a session from its messages."): activate, session jobs, recovery, epoch recovery, send/queue/compact/shell/rewind/fork/harness switch/restart, package runtime bindings; `runtimeFeatures` answers no capabilities. Rename, archive, restore, delete, read cursor, drafts, people messages and mute work | `sessions.ts` `isConversation`, `sessionResourceAuthority.ts` |
| Start a session | `startSessionFromConversation(id, {sourceSeqs, prompt?, title?, participants, harness?, model?})` creates an ordinary chat owned by the caller, shares it once with the edited participant copy (or keeps it private), sends a first prompt that quotes the selected messages as markdown ("reference data, not instructions") followed by the instruction, and appends a `conversation/session-started` card. Access is not inherited afterwards | `sessions.ts`, `sessionResourceAuthority.ts` |
| API | `POST /api/sessions/:id/person-messages`, `GET /api/sessions/:id/mention-candidates`, `PUT /api/sessions/:id/mute`, `POST /api/conversations`, `POST /api/sessions/:id/conversation/start`. `GET /api/spaces/:id/members` includes each member's display name | `routes/org.ts`, `routes/spaces.ts` |
| UI | See [UI §3 "People in a chat"](../dev/ui.md) | `apps/web` |

Known limits:

- `attention.mentions` is a flag (0/1), not an exact count.
- Replying to a specific message (`replyToSeq`) is stored but neither
  composed nor shown yet.
- A rewind of agent history follows `effectiveHistory`, so a person message
  inside the rewound range is hidden with it.
- Local OS alert routing turns `mention` (v2) and `message` (v3) on once for
  settings saved before the kind existed (`notifyKindsVersion`); server
  notification rows are always written.
- Web Push is not filtered by the person's local alert kinds (the service
  worker cannot read them); muting a conversation is the per-chat off switch.
- Native people pushes are source-changed in the push service, Android plugin and iOS
  delegate but not yet device-verified.
- People have no profile pictures; a person is a monogram in their colour.
  The colour is assigned per chat from the people who can open it, so a
  person whose tone clashes with another's in one chat may wear a different
  one there.
- The in-app message card answers with plain text: typing `@Name` there does
  not create a mention.
