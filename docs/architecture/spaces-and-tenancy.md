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
| Package host | `packages/plugins/src/serverPackage.ts` | `storageDir` = the one data dir for every package. |
| Secrets | `packages/secure-safe` | One store, one manifest, deployment-wide. |
| Integrations | `ssh.json`, `mcp.json`, `schedule.json`, `workflows.json`, `quotas.json`, `knowledge.db` | All single-file, deployment-wide. |
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
- `Project.spaceId?` in `projects.json`.
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

`ServerPackageHost` now carries `spaceStorage(ctx)` and `deployment`.
`storageDir` is retained and re-documented as the **shared, non-tenant** root —
correct for deployment-wide state (a binary cache, a trusted registry), wrong
for anything a Space owns. Packages holding tenant state there are being
migrated; new tenant state goes through `spaceStorage`. See §6.

### 2.9 Security risks (current, honest)

| Risk | State |
|---|---|
| Core resources (projects, sessions, labels, folders, search, WS) | **Closed** — scoped facades + indexed filters + per-socket binding, with tests. |
| Feature-package state (`ssh.json`, `mcp.json`, `secure-safe`, `schedule.json`, `workflows.json`, `knowledge.db`, `permissions.json`, `quotas.json`, browser shots) | **Open** — still deployment-wide. A second Space sees the first's integrations and Secure Safe. Acceptable for `local-trusted`; a blocker for anything else. |
| Execution | **Open** — everything runs on the host as the server user. |
| Tenant packages | **Open** — a package's server entry runs in the control plane. Gated by `allowsTenantPackagesInControlPlane`, which is only true for `local-trusted`. |
| Host filesystem browsing | **Closed for hosted** — `/api/browse` refuses under `multi-tenant-sandboxed`. |
| Runtime pool / model catalog | **Partly closed** — the catalog now aggregates only the caller's Space; the pool is keyed by project + resolved cwd, and project ids are Space-owned, so pool keys cannot collide across Spaces. Warm processes are still shared per project, which is correct (one project belongs to exactly one Space). |
| Restart recovery | **Partly closed** — recovery runs before the gateway serves and re-derives ownership from the adopted projections, but there is no tenant assertion inside the recovery path itself. See §7. |
| Identity | **Single identity** — every human principal maps to one bootstrap user, because Polyth still has one shared password. Multi-user needs per-user credentials; the boundary is already in place for it. |
| Internal control callers | **Explicit** — the filesystem-protected control socket (`data/control.sock`, Polyth's own MCP) does not resolve a tenant from ambient state. `SpaceGateway.resolveInternal(spaceId?)` binds it to the installation owner and, in `multi-tenant-sandboxed`, refuses entirely: there is no ambient operator to act as, so the caller must be handed a context. |

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

1. `@polyth/secure-safe` becomes Space-owned (`spaceStorage(ctx)` instead of
   `dataDir`), with the same migration shape as projects/sessions.
2. The same for SSH connections, MCP secrets, provider credentials, Home
   Assistant tokens, and any `POLYTH_*` env passthrough.
3. A broker service between the safe and the executor, with the audit hook
   already present in `@polyth/tenancy` (`AUDIT.secretResolved`).

Until then, a Hobby Space *can* reach Work's credentials on the same server.
That is the single most important open gap and is why `server-trusted` and
above are not yet supportable.

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

Every isolation assertion uses **known-valid ids from the other Space**, not
guessed ones: guessing only proves the id space is large.
