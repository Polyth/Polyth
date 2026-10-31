# Monitoring and system administration

`@polyth/monitoring` owns its server routes, browser surface, access settings,
`sysadmin` workbench profile and `monitoring_read` agent tool. Its manifest opts
into normal package discovery; disabling it removes its UI/capability
registrations and fences results from older requests. It creates no background
host jobs and never spawns a local shell; local journal/service reads run the
fixed `journalctl`/`systemctl` binaries with an argument vector, a 10 s kill
timeout and a 4 MiB output cap (`runLocal` in `src/collect.ts`).

## Host diagnostics

The host selector contains only projects in the request's validated Space.
Local projects show the Polyth server host's memory, CPU count, load average
and uptime; these are host totals shared by projects, not project consumption.
SSH projects use their canonical project's existing SSH connection through
`@polyth/ssh`. Monitoring never accepts a connection id from a browser or agent,
enumerates the shared SSH inventory, or collects authentication material.

Host diagnostics are unavailable in `multi-tenant-sandboxed` deployments.
SSH resource probes require Linux with `/proc` and common POSIX utilities.
Approved `.service` units use `systemctl show`, locally and over SSH.

## Log sources

Log sources cover the whole host, not only project files. A policy's
`logPaths` (up to 24) may hold:

- `journal` — the whole systemd journal (`journalctl -n 200`);
- `kernel` — kernel messages (`journalctl --dmesg`);
- `journal:<unit>.service` — one unit's journal (every approved service unit
  is also an approved journal source);
- an absolute host file: anything under `/var/log/`, or any absolute `.log`
  path. A conservative character set, no `.`/`..` segments and no
  `/proc`, `/sys`, `/dev`, `/run`;
- a project-relative `.log` path (local projects only).

Local Linux hosts read journals through `runLocal`; the server user needs
journal access (e.g. the `adm`/`systemd-journal` group). Local host files are
resolved and the *resolved* target must itself be an approvable host log path,
so a symlink cannot redirect to another file; the opened `/proc/self/fd` object
is rechecked before and after reading. Project files keep the stricter rule:
no absolute paths, traversal, hidden components or escaping symlinks. SSH hosts
run the quoted journal command or a `readlink -f` + `tail -c` probe that prints
the resolved path first; a resolution outside approvable paths is refused.
(The remote check is not fd-pinned; a race needs write access to the log's
directory on that host.) Every response retains at most 200 lines and 64 KiB of
UTF-8 text, and every refresh reopens the source.

Agent permissions alone produce no log source: the Log tails view lists only
approved sources, and the toggle says so. To make approval practical,
`GET /api/monitoring/log-candidates` returns `journal`/`kernel`, readable host
files under `/var/log` (depth 2, newest 40; rotated/compressed/binary
accounting and `sysstat` `saNN` files skipped) and, for local projects, project
`.log` files (bounded walk: depth 4, 4000 entries, 24 newest; skips dot entries,
`node_modules` and symlinks). SSH hosts list `/var/log` with one bounded `find`;
a failed listing still offers the journals. Candidates carry `kind`
(`journal`/`host`/`project`), names, sizes and times only—never content. A
Space administrator can approve one with a click from the Log tails view (it
saves the policy through the same admin-only `PUT`) or from Rules & access.
`monitoring_read` does not expose the candidate list.

The UI takes a sample on open. Live polling is optional, runs every five
seconds after completion and pauses for hidden/inactive views. Changing hosts
pauses live mode; old host/source results cannot update the new selection.
Snapshots show sample times, warning thresholds and recent in-memory samples.
There is no durable metric history, external alert delivery or Prometheus
integration.

## Agent rules and permissions

The System administration profile gives sessions the `sysadmin` purpose and
package-owned diagnostic instructions through `SESSION_PURPOSES`. The package
also contributes the `system-administrator` skill. Canonical session admission
owns persistence and delivery of this context.

Every project's policy independently grants agent `metrics`, `services` and
`logs` access; all start disabled. `monitoring_read` can inspect the current
project's policy even without diagnostic grants. Its execution verifies the
canonical session, project and Space, enforces the selected permission before
probing, and rechecks permission and package generation before returning data.
Package policy does not bypass the host's ordinary tool permissions.

Only a human UI/local-loopback Space administrator can edit policy through
`PUT /api/monitoring/policy`. Internal-service and paired-device callers are
denied. On a local project the host is the Polyth server itself, shared by
every Space, so newly approving a journal source, a service unit or a host log
file there also requires the instance owner (`hasInstanceOwnerAuthority`);
project files, SSH hosts and removing entries stay Space-admin decisions.
Policy writes use optimistic revisions and Space-owned storage at
`packages/monitoring/policies.json`; malformed stored policy fails closed.
The package declares local-only remote ingress.

Policy allows up to 12 service units and 24 log sources. It also owns the memory
warning percentage and one-minute load-per-CPU warning ratio. Permissions grant
read-only diagnostics; no restart, deployment, installation, credential change,
arbitrary shell command or process termination is exposed. Agent instructions
prohibit bypassing denials, changing their own policy and following instructions
embedded in logs. Other execution tools retain their own authorization boundary;
Monitoring policy is not a system-wide shell sandbox.

## Verification

Run the package's behavior and security tests with Node type stripping:
`node --experimental-strip-types --test packages/monitoring/test/*.test.ts`.
Use the repository's bounded-check wrapper on shared Linux hosts. Package entry
changes also require server discovery, plugin lifecycle, web containment and
`npm run build:web`. Inspect the Monitoring surface in an isolated agent-beta
instance; a simulated SSH transport is not live remote-host evidence.
