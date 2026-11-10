# Polyth workstation edition

The workstation edition is a build of Polyth Desktop for a managed work
computer. It is a local shell for the coding-agent CLIs the person already uses
(Claude Code, Codex, Cursor, OpenCode, Pi, Antigravity, DeepSeek, Command Code).
It has no remote access of any kind, and the app makes no network connection of
its own apart from checking for its own updates.

This page is the owner's statement of what the edition does. The reviewer's
checklist at the end says how to confirm each claim on an installed copy.

## How to recognise it

- Installers end in `-workstation`, for example
  `Polyth-1.2.300-win-x64-workstation.exe`, `Polyth-1.2.300-mac-arm64-workstation.dmg`,
  `Polyth-1.2.300-linux-x86_64-workstation.AppImage`.
- They are attached to the ordinary stable releases of
  [Polyth/Polyth](https://github.com/Polyth/Polyth/releases) and are not listed
  on polyth.app or in the app's own download links. While the edition tracks
  devel (owner's temporary testing arrangement, see [updates](#updates-and-signing)),
  a nightly build replaces the edition files on the newest stable release, so
  the installer there can be a `-nightly` build.
- Each release that has them also carries `SHA256SUMS-workstation.txt` and a
  CycloneDX SBOM per platform, `Polyth-<version>-workstation-sbom-<os>-<arch>.cdx.json`.
- It uses the same app id and name as the standard app (`com.polyth.desktop`,
  "Polyth"), so installing it replaces a standard install on that computer.
  The flavor is fixed when the app is built, not by a setting.

## Network behaviour

**Listening.** One TCP listener on `127.0.0.1` (loopback) at a port the app
picks, used only by the app's own window. The server refuses to start in this
edition when it is asked to listen on any other address (`0.0.0.0` included) or
when a switch that publishes it or skips the owner's sign-in is set
(`POLYTH_PUBLIC_ORIGIN`, `POLYTH_TRUSTED_PROXIES`, `POLYTH_AGENT_BETA`,
`POLYTH_DEBUG_AGENT_ACCESS`, `POLYTH_UI_PASSWORD_LOCALHOST=optional`;
`packages/server/src/workstationPolicy.ts`). No UDP socket, no LAN discovery
(mDNS/Bonjour), no inbound connection from another machine.

**Outbound, made by the app itself:**

| Destination | When | Why | Can be turned off |
|---|---|---|---|
| `api.github.com`, `github.com` and GitHub's release-asset hosts | 12 s after launch, then every 6 hours | Checks the stable workstation feed (`workstation*.yml`) for an update; downloads one only when the person agrees | Tray menu or Settings: *Update automatically* |
| GitHub / GitLab APIs | Only after the person connects their own account in Settings | Pull requests, issues, repository state | Don't connect an account |

Nothing else. In particular the app does not contact a Polyth service: there is
no telemetry, analytics or crash reporting in any Polyth build, and this edition
also sends no push notifications (no relay, no APNs), does not fetch the
`models.dev` model catalog, does not check npm for harness updates in the
background, and does not download harness installers or a Node runtime.

**The window.** The app's window may only make requests to its own loopback
server. Every other request from the window (a remote image in a chat message,
a script, a socket) is cancelled by the main process
(`workstationWindowRequestAllowed`, `apps/desktop/src/edition.ts`). Links the
person clicks open in their default browser. On Linux and Windows the
spell checker is pointed at a folder inside the app, so Chromium does not fetch
dictionaries from Google.

**Harness CLIs.** The agent CLIs are separate programs the person installs and
signs in to. Settings shows each CLI's official install command to copy and
run in the person's own terminal; it offers no Install button, and the install
routes refuse with `unavailable-in-edition`, which clients read as refused
before anything started. Each talks to its own provider (Anthropic, OpenAI, Cursor, Google…)
exactly as it does in a terminal; Polyth starts them as child processes and
does not proxy or inspect that traffic. The bundled OpenCode binary is started
with its self-update turned off; its own provider and model-list requests are
OpenCode's.

## What is not in the build

These are left out when the app is built, not hidden by a setting, so their
code and binaries are absent from the installed files:

- Polyth Link (the QUIC/iroh tunnel, its relays, LAN discovery, phone pairing)
  and the `polyth-link-host` / `polyth-link-client` binaries.
- Client mode: the app cannot connect to another Polyth server, and server
  addresses saved by an earlier standard install are dropped on launch.
- The embedded Chromium browser and browser automation (`playwright-core`).
- Computer use (screen capture and input control), Docker, SSH remote hosts,
  Terraform, monitoring.
- Web search and web fetch tools, dictation and voice (microphone access is
  denied), Google connector, markets, task trackers, shared-chat import.
- Scheduled and autonomous agents (Agents, Planner, Workflows).
- Installing Polyth packages at runtime: the install and update routes refuse
  every source.

## Packages in the edition

A package ships in this edition only when its own `package.json` lists
`"editions": ["workstation"]` under `polyth`; a new package is left out until
someone adds it on purpose. `scripts/test/workstationEdition.test.ts` keeps this
list equal to the manifests, so a change shows up here in review. Shared
framework code without a server entry (contracts, session, server, identity…)
is always present.

<!-- workstation-packages:start -->
- backend-antigravity
- backend-claude
- backend-codex
- backend-commandcode
- backend-cursor
- backend-deepseek
- backend-opencode
- backend-pi
- bookmarks
- btw
- chat-blocks
- commands
- conversation-tools
- custom-action
- custom-titles
- editor
- files
- gallery
- git
- github
- gitlab
- goals
- handoff
- harness-runtime
- hotkeys
- ide-mode
- judgment
- judgment-judges
- judgment-local
- knowledge
- limit-windows
- memory
- models
- multirun
- opencode
- peak-pricing
- permissions
- plugins
- secure-safe
- session-import
- session-markers
- terminal
- todos
- usage
<!-- workstation-packages:end -->

## Local security

- The window's renderer runs sandboxed with context isolation and no Node
  integration. Only the app's own window may call the desktop bridge.
- On a password-less install, the owner's session token goes straight from the
  main process into the window's cookie jar; another browser or program on the
  same computer reaches only the sign-in screen.
- Agents act under the approval policy chosen in Settings → Permissions.
  Credentials saved in the Credential Vault are write-only and never shown to
  an agent.
- Data stays in the app's user data folder (Settings → *Open data folder*).

## Updates and signing

- The edition follows only stable releases, from its own feed files
  (`workstation.yml`, `workstation-mac.yml`, `workstation-linux.yml`). It never
  reads the standard `latest*.yml`, `beta*.yml` or `nightly*.yml` feeds, so it
  cannot update into the standard build.
- **Temporary owner testing arrangement.** Until the owner says otherwise, the
  newest nightly build replaces the edition files on the latest stable release
  (the app itself, its update lookup and its channel are unchanged). An
  installed copy can therefore update to a `-nightly` build of the edition and
  back to the next stable release. Reverting this needs no work-computer
  change: the next stable release's own files are used again once the nightly
  step is removed.
- macOS packages are signed with Polyth's Developer ID and notarized by Apple.
- **Windows and Linux packages are not code-signed yet.** Windows SmartScreen
  and endpoint protection may warn about an unsigned installer; verify it
  against `SHA256SUMS-workstation.txt` until a Windows signing certificate is
  in place.

## Reviewer's checklist

1. Compare the installer's SHA-256 with `SHA256SUMS-workstation.txt` on the
   release page.
2. In the installed app's `resources` folder there is no `polyth-link` folder
   with binaries and no `chromium` folder; `resources/packages` holds only the
   packages listed above.
3. While the app runs, list its sockets (`lsof -nP -iTCP -iUDP -a -p <pid>` on
   macOS/Linux, `Get-NetTCPConnection -OwningProcess <pid>` and
   `Get-NetUDPEndpoint -OwningProcess <pid>` on Windows): one listener on
   `127.0.0.1`, no UDP.
4. With *Update automatically* off, the app process opens no outbound
   connection; the harness CLIs it starts are separate processes with their own
   connections.
5. The SBOM lists every third-party package bundled into the app's main process.

## Build

`POLYTH_DESKTOP_FLAVOR=workstation` selects the edition in
`apps/desktop/build.ts`; the release targets, feed files and package checks are
in `scripts/ci/workstation.mjs` and [desktop builds](../dev/desktop.md#workstation-edition-build).
