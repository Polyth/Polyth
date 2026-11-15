# Monitoring and system administration

`@polyth/monitoring` owns its server routes, browser surface, access settings,
`sysadmin` workbench profile and `monitoring_read` agent tool. Its manifest opts
into normal package discovery; disabling it removes its UI/capability
registrations and fences results from older requests. Its only background work
is the one-minute alert loop and a one-minute history reading of the Polyth
server itself, and it never spawns a local shell; local journal, service and
system-constant reads run the fixed `journalctl`/`systemctl`/`getconf` binaries
with an argument vector, a 10 s kill timeout and a 4 MiB output cap (`runLocal`
in `src/collect.ts`).

## Host diagnostics

The picker lists machines, not projects: projects sharing a machine show the same
numbers, so `machinesOf` keeps one row per `machineId` (`local`, or an opaque hash
of the SSH connection id). It contains only projects in the request's validated
Space, and the chosen project's policy applies. Readings are host totals shared by
projects, not project consumption: memory, CPU count, load average, uptime, real
filesystems and Linux pressure stalls. Disks are block devices (`/dev/*`, without
loop devices, boot, snap or container layers), one row per device, at most six,
falling back to `/` on a container's overlay. Pressure is `some avg60` from
`/proc/pressure`, absent on a kernel without it. SSH projects use their canonical project's existing SSH connection through
`@polyth/ssh`. Monitoring never accepts a connection id from a browser or agent,
enumerates the shared SSH inventory, or collects authentication material.

Host diagnostics are unavailable in `multi-tenant-sandboxed` deployments.
SSH resource probes require Linux with `/proc` and common POSIX utilities; disks
and pressure are optional sections of the probe, so a host without them still
reports the rest. Approved `.service` units use `systemctl show`, locally and over
SSH.

## Processes

`GET /api/monitoring/processes` groups processes by name with the CPUs they kept
busy and their resident memory. It reads `/proc/<pid>/stat` twice, two seconds
apart, in process locally and with one fixed command over SSH. Only names are
collected, never command lines or environments. Resident memory counts shared pages
in every process, so groups can add up to more than is in use; the screen says so.
Viewers of one machine in one Space share the sample under way; nothing is cached
after it ends.

A local project's processes belong to the Polyth server, across every Space, so the
route and `processesAvailable` admit only the instance owner there. SSH hosts belong
to the Space.

## History

`src/history.ts` keeps the 5-minute load per CPU, memory percent and fullest disk
percent per machine, in Space-owned storage at `packages/monitoring/history.json`:
one-minute steps for an hour, five for a day, thirty for a week. Each step keeps the
highest reading it saw. Writes happen at most every 5 minutes and when the package
stops, so a restart can lose that much; a damaged file is an empty chart. Numbers
only, with no connection id.

The server records itself once a minute for each Space with a local project, without
probing anything. SSH hosts are never dialled for history: they gain points from the
alert loop when their policy grants access and from open screens, and a gap breaks
the chart's line. `GET /api/monitoring/history?range=1h|24h|7d` reads it.

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

Agent permissions alone produce no log source: the Logs tab lists only
approved sources, and the toggle says so. To make approval practical,
`GET /api/monitoring/log-candidates` returns `journal`/`kernel`, readable host
files under `/var/log` (depth 2, newest 40; rotated/compressed/binary
accounting and `sysstat` `saNN` files skipped) and, for local projects, project
`.log` files (bounded walk: depth 4, 4000 entries, 24 newest; skips dot entries,
`node_modules` and symlinks). SSH hosts list `/var/log` with one bounded `find`;
a failed listing still offers the journals. Candidates carry `kind`
(`journal`/`host`/`project`), names, sizes and times only—never content. A
Space administrator can approve one with a click from the Logs tab (it saves the
policy through the same admin-only `PUT`) or from Settings.
`monitoring_read` does not expose the candidate list.

## The screen

The Overview answers whether the machine is OK before showing any number: a headline
naming what is over its limit, one primary action, then one row per reading with its
limit marked, worst first. Below are the chart, what is using the machine and the
services. Permissions and limits live on the Settings page, reached from a row here,
so the surface has only Overview and Logs tabs. `widgets/model.ts` holds this logic
without a DOM.

Readings are live whenever the surface is on screen: every 5 seconds locally and 15
over SSH, after the previous one completes, stopping while hidden. There is no toggle
or refresh button. A failed read keeps the last numbers, dimmed and stamped with their
time, under a "Can't reach" headline with a Try again action. Old host or source
results cannot update a new selection.

Logs follow the newest line while the reader stays at the end; scrolling back pauses
polling until they return. The tabs and source picker stay in reach (sticky), lines
wrap instead of scrolling inside a box, and a client-side filter shows just the lines
that look like problems.

There is no external alert delivery or Prometheus integration.

## The widget

`monitoring.machine` is one canvas and phone-panel widget (`defaultVisible: false`,
duplicatable) whose look is a per-instance choice. Its rules live without a DOM in
`widgets/widgetModel.ts`; the views are `MonitoringWidget.tsx` (data, size, states),
`widgetLooks.tsx` and `WidgetSettings.tsx`.

- **Looks.** Summary (verdict sentence; at the large size a chart of the subject),
  Scales (270° dials with the limit tick), Charts (sparkline rows with a shared
  cursor and a range switch) and Rhythm (seven days × 24 hours of load or memory with
  one sentence about the pattern). Choosing **All machines** as the machine shows every
  readable machine instead: one snapshot each, at most 12, the ones that need a look
  first.
- **Config.** `{look, machine, metrics, range, forecast, quiet, rhythmMetric}`,
  always read through `widgetConfigOf`. `machine` is `current` (the project the widget
  sits in), `all`, or a `machineId`; a chosen machine that is gone is said plainly
  rather than replaced. An empty `metrics` means problems first (`vitalsOf` order);
  otherwise exactly the picked vitals, in that order. Limits are not per widget: they
  are the project's policy, shared with the window.
- **Tone.** `warn` while anything is over its limit (amber, one primary action: ask an
  agent, or open its existing incident chat); `watch` when the fullest disk will reach
  its limit within 7 days (words only, no amber); `ok`; `lost` when the host cannot be
  read. Quiet mode hides everything but the dot and the name, and only while the tone is
  `ok`.
- **Forecast.** A least-squares line through the last 7 days of the fullest disk's
  readings (at least 12 readings over 12 hours). It is shown only for growth of at
  least 0.05 points a day and no further out than 30 days. Under the limit it says when
  the disk reaches the limit; over it, when the disk fills. Charts draw it in its own
  zone after a break, never as a continuation of the line.
- **Scales on small charts.** Load grows to fit and always shows its limit. A
  percentage starts at zero, or, where the row has room to label it, at a round floor
  below the readings and the limit. Only load is filled under its limit; a
  percentage near full would paint a slab. A chart with fewer than 3 readings says so
  instead of drawing an empty frame.
- **History is per machine, not per disk.** It keeps the fullest disk's percent, so
  only that disk gets a line or a forecast; every other disk shows its current fill
  against its limit.
- **Phone panel.** The Workspace panel gives a widget its content height, so with
  `context.panelSize` the root is marked `data-panel` and each part brings its own
  height; compact Charts keep the single worst row and compact Rhythm only the grid.
- **Polling.** A snapshot every 15 seconds locally and 30 over SSH, history every 5
  minutes, and only the history the current look and size draw. One `/hosts` request is
  shared by every instance for a minute.

## Agent rules and permissions

The System administration profile gives sessions the `sysadmin` purpose and
package-owned diagnostic instructions through `SESSION_PURPOSES`. The package
also contributes the `system-administrator` skill. Canonical session admission
owns persistence and delivery of this context.

Every project's policy independently grants agent `metrics`, `services`, `logs` and
`processes` access; all start disabled, and a policy stored before `processes`
existed denies it. `monitoring_read` can inspect the current project's policy even
without diagnostic grants; its `history` action needs the `metrics` grant. Its execution verifies the
canonical session, project and Space, enforces the selected permission before
probing, and rechecks permission and package generation before returning data.
Package policy does not bypass the host's ordinary tool permissions.

Only a human UI/local-loopback Space administrator can edit policy through
`PUT /api/monitoring/policy`. Internal-service and paired-device callers are
denied. On a local project the host is the Polyth server itself, shared by
every Space, so newly approving a journal source, a service unit or a host log
file, or newly granting `processes`, there also requires the instance owner
(`hasInstanceOwnerAuthority`); project files, SSH hosts and removing entries stay
Space-admin decisions.
Policy writes use optimistic revisions and Space-owned storage at
`packages/monitoring/policies.json`; malformed stored policy fails closed.
The package declares local-only remote ingress.

Policy allows up to 12 service units and 24 log sources. It also owns the memory
and disk warning percentages and the load-per-CPU warning ratio, compared with the
5-minute average so one busy minute is no warning. A writer that predates the disk
limit keeps the stored value instead of resetting it. Permissions grant
read-only diagnostics; no restart, deployment, installation, credential change,
arbitrary shell command or process termination is exposed. Agent instructions
prohibit bypassing denials, changing their own policy and following instructions
embedded in logs. Other execution tools retain their own authorization boundary;
Monitoring policy is not a system-wide shell sandbox.

## Warnings, agents and incident chats

`src/alerts.ts` samples every minute the projects whose policy grants agents
metrics or services access. A warning is news only when it appears: the first
sample after start is a baseline, and a warning type seen within the last
15 minutes (`ALERT_CLEAR_MS`) is the same episode, so a threshold that flaps
never alerts twice. A project with an agent waking on Monitoring gets an agent
event instead of a chat. Otherwise the project gets one `sysadmin` incident
chat per incident: it stays the project's incident until no warning of any
type was seen for 2 hours (`INCIDENT_QUIET_MS`), and later alerts inside that
window only notify on it — no new chat, no new turn. A chat the person archived
or deleted inside the window stays closed; an unreadable session state counts
as open, so uncertainty never opens a duplicate. Incident chats carry
`origin` `{source: "monitoring", wake: "alert", label: "Monitoring"}` so lists
draw them as automation. The incident state (`sessionId`, `openedAt`,
`lastWarningAt` per project; nothing else) survives restarts in Space-owned
storage at `packages/monitoring/incidents.json` (`src/incidents.ts`; writes
throttled to one per 5 minutes while a warning persists; a damaged file is
empty state). At most `INCIDENT_CHAT_LIMIT` incident chats are inside their
window at once across the instance.

A full disk (`disk-high`) follows the same path as memory and load, gated by the
`metrics` grant. The first sample after start is still a baseline, so a disk already
over its limit opens nothing until it clears and returns.

`POST /api/monitoring/ask` is the screen's "Ask an agent to look". It needs the
`metrics` grant and a person: internal services and limited paired devices are refused.
It reuses the project's open incident chat; otherwise it opens a `sysadmin` chat as
the person asking, with no automation `origin`, records it as the incident so later
alerts notify it, and sends the current warnings as data. `GET /api/monitoring/incident`
tells the screen to offer that chat instead.

## Verification

Run the package's behavior and security tests with Node type stripping:
`node --experimental-strip-types --test packages/monitoring/test/*.test.ts`.
Use the repository's bounded-check wrapper on shared Linux hosts. Package entry
changes also require server discovery, plugin lifecycle, web containment and
`npm run build:web`. Inspect the Monitoring surface and the widget in an isolated
agent-beta instance; a simulated SSH transport is not live remote-host evidence.
`test/widgetModel.test.ts` covers the widget's config, machine choice, forecast, tone,
rhythm and fleet order; run it once more under another `TZ`, because the rhythm groups
readings by local day and hour.
