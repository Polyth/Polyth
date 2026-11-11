# GitHub Copilot harness (`backend-copilot`)

Runs [GitHub Copilot CLI](https://github.com/github/copilot-cli) (`copilot`,
npm `@github/copilot`) as a Polyth harness through its ACP stdio server and the
shared [`backend-acp`](../backend-acp) adapter. The harness id is `copilot`;
extra logins register as `copilot-<account>`.

Copilot's ACP server is a public preview. Everything below was verified
against Copilot CLI 1.0.109 on Linux aarch64 with the real executable and a
local fake model provider (`COPILOT_PROVIDER_BASE_URL`), so no GitHub sign-in
and no paid turn was involved. A turn on GitHub's own model routing, and the
macOS and Windows builds, have not been run.

## Install and sign in

- Install: Settings → Harnesses installs `@github/copilot` from npm. The
  package ships a native binary for Linux (glibc and musl), macOS and Windows,
  x64 and arm64, and the install command brings its own Node.js when the
  machine has none. A CLI installed another way (Homebrew, WinGet, GitHub's
  install script) is found too.
- Already installed, outside PATH: when nothing is found on PATH or in the
  usual install folders, Polyth uses the copy GitHub's own installers left.
  The Windows installer (`copilot-x64.msi`, `copilot-arm64.msi`) puts
  `copilot.exe` in `%LOCALAPPDATA%\GitHubCopilotCLI` and adds it to the user's
  PATH only. The GitHub Copilot app (macOS `.dmg`, Windows `-setup.exe` or
  `.msi`, Linux packages) carries the CLI inside and unpacks it on first start
  to `<cache>/github-copilot-sdk/cli/<version>/copilot[.exe]`, where `<cache>`
  is `~/Library/Caches`, `%LOCALAPPDATA%` or `~/.cache`; the newest complete
  copy is used. Open the app once so that copy exists. The app pins its own
  CLI version and replaces it when the app updates, so Settings' Update button
  does not apply to that copy. Updates run `copilot update`; the release
  check reads the npm `latest` tag. Override the executable with
  `POLYTH_COPILOT_BIN`. Another program named `copilot` (the AWS Copilot CLI)
  is not launched: `copilot --version` must name GitHub Copilot CLI.
- Sign in: `copilot login` (browser), or `copilot login --device-code` when the
  browser is on another machine. The CLI keeps the token in the system
  keychain, or in `$COPILOT_HOME` when there is none. A token in the Polyth
  server's environment (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`)
  and a signed-in `gh` are used by the CLI as it documents.
- Own model provider: with `COPILOT_PROVIDER_BASE_URL` (or
  `COPILOT_PROVIDERS_CONFIG`) in the server's environment the CLI needs no
  GitHub login, and the harness reports "Own model provider".
- Sign-in status: the CLI has no status command and Polyth does not read its
  credential store. The Accounts list asks the agent itself: a signed-out CLI
  refuses ACP `session/new` with `-32000 Authentication required`. That
  starts the CLI, so the installation probe does not do it; it reports
  `unknown` unless the launch environment holds a token or a provider, and
  model discovery reports `auth-required` from the same refusal.
- Accounts: each extra login gets its own `COPILOT_HOME`. The server's token
  variables are removed from an account's environment, because a token there
  wins over every stored login. An account that has not signed in can still
  be served by a signed-in `gh` (the CLI's last fallback).

## What is wired

| Area | Behaviour |
| --- | --- |
| Launch | `copilot --acp --stdio --no-auto-update --excluded-tools=…` in the session's cwd, plus the MCP file below; the first four arguments on an SSH host. |
| Delegation | `--excluded-tools` removes Copilot's agent tools (`task`, `read_agent`, `list_agents`, `write_agent`, `run_dynamic_workflow`, `dynamic_workflows_manage`); delegation goes through Polyth `agent.spawn`. The `/fleet` and `/delegate` slash commands are still advertised by the CLI. |
| Models | The `model` config option of `session/new`; `reasoning_effort` is the thinking level of models that have one. Context limits come from the `github-copilot` catalog rows and from ACP `usage_update`. |
| Permissions | `session/request_permission` with allow once, always allow and deny. Copilot runs commands it classifies as read-only without asking. |
| Attachments | Images and text files natively; links as `resource_link`; PDFs through Polyth's text projection. |
| Usage | Each `session.usage_record` of the CLI's session log becomes one exact `usage/recorded` before `turn/stopped`. Copilot counts cache reads inside its input, so they are taken out. Not available on SSH hosts, where the log is not on this machine. |
| Failures | The CLI writes its own `Error: …` line into the answer and ends the prompt normally. That line ends the turn as failed and is classified (sign-in, rate limit and overload with auto-resume, used-up allowance, unavailable model, full context). Its `Info: …` lines (retrying, cancelled) are not shown. |
| Resume | `session/load`; the replayed history is not re-emitted. |
| Commands | The CLI's slash commands and skills (`/compact`, `/context`, `/usage`, `/plan`, …) are offered as native commands and sent as the prompt text. |
| Small model | Commit messages, titles and other utility text use `copilot -s` with the prompt on stdin, in the system temporary directory. |
| Skills | `.github/skills`, `.agents/skills`, `.claude/skills` in the project; `$COPILOT_HOME/skills` and `~/.agents/skills` for the person. |
| MCP | Copilot's ACP server takes only HTTP and SSE servers on `session/new` and refuses stdio ones, which is what the Polyth tools are. Stdio servers are therefore written to an owner-only file in the Space's runtime storage and loaded with `--additional-mcp-config=@<file>` when the chat's process starts; the file is removed when that process is released. HTTP servers still go on `session/new`. Nothing secret is put on the command line. Not delivered on SSH hosts, as for every ACP harness. |
| Polyth tools | Copilot names an MCP tool `<server>-<tool>`, so Polyth's own tools arrive as `polyth-agent-tools-…`; permission requests and tool cards carry that name, and the session todo list is approved without asking as on other harnesses. |
| Import | Native sessions of the same workspace are listed for Snapshot import (prompts and visible replies only). |

## Not covered

- Copilot plan limits in Usage: reading them needs the CLI's GitHub token,
  which Polyth does not touch.
- Plan and Autopilot modes and the `allow_all` switch are advertised as ACP
  config options but are not offered in Polyth; approvals are Polyth's.
- Questions to the person: the CLI exposes none over ACP.
- Crash-safe switching to another harness needs Linux and a local project,
  as for every ACP harness.
- The preinstalled locations were read from the installers and the Copilot
  SDK source (CLI 1.0.109 Windows package, app 1.2.0); they were not run on a
  Mac or a Windows machine. Whether the app's login also serves the CLI it
  unpacked was not checked.
