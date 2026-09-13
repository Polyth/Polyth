// Electron bundles server code into main.js, so runtime filesystem discovery
// cannot see individual package entries. Keep the feature entry points static
// here; esbuild then includes them in the desktop main-process bundle.
import type { PackageDescriptorDto } from "@polyth/contracts";
import type { ServerPackageFactory } from "@polyth/plugins";
import type { ServerPackageRegistration } from "@polyth/server";
import chatWorkspace from "../../../packages/chat-workspace/src/serverEntryWithDeviceRuntime.ts";
import handoff from "../../../packages/handoff/src/serverEntry.ts";
import browser from "../../../packages/browser/src/serverEntry.ts";
import commands from "../../../packages/commands/src/serverEntry.ts";
import customAction from "../../../packages/custom-action/src/serverEntry.ts";
import dictation from "../../../packages/dictation/src/serverEntry.ts";
import exampleFeature from "../../../packages/example-feature/src/serverEntry.ts";
import files from "../../../packages/files/src/serverEntry.ts";
import editor from "../../../packages/editor/src/serverEntry.ts";
import fusion from "../../../packages/fusion/src/serverEntry.ts";
import git from "../../../packages/git/src/serverEntry.ts";
import gitlab from "../../../packages/gitlab/src/serverEntry.ts";
import github from "../../../packages/github/src/serverEntry.ts";
import goals from "../../../packages/goals/src/serverEntry.ts";
import homeAssistant from "../../../packages/home-assistant/src/serverEntry.ts";
import hotkeys from "../../../packages/hotkeys/src/serverEntry.ts";
import knowledge from "../../../packages/knowledge/src/serverEntry.ts";
import markets from "../../../packages/markets/src/serverEntry.ts";
import models from "../../../packages/models/src/serverEntry.ts";
import multirun from "../../../packages/multirun/src/serverEntry.ts";
import permissions from "../../../packages/permissions/src/serverEntry.ts";
import plugins from "../../../packages/plugins/src/serverEntry.ts";
import schedule from "../../../packages/schedule/src/serverEntry.ts";
import secureSafe from "../../../packages/secure-safe/src/serverEntry.ts";
import ssh from "../../../packages/ssh/src/serverEntry.ts";
import taskTrackers from "../../../packages/task-trackers/src/serverEntry.ts";
import terminal from "../../../packages/terminal/src/serverEntry.ts";
import tunnel from "../../../packages/tunnel/src/serverEntry.ts";
import usage from "../../../packages/usage/src/serverEntry.ts";
import walkthrough from "../../../packages/walkthrough/src/serverEntry.ts";
import workflow from "../../../packages/workflow/src/serverEntry.ts";

import backendAcp from "../../../packages/backend-acp/src/serverEntry.ts";

import backendClaude from "../../../packages/backend-claude/src/serverEntry.ts";
import backendCodex from "../../../packages/backend-codex/src/serverEntry.ts";
import backendCommandCode from "../../../packages/backend-commandcode/src/serverEntry.ts";

import backendCursor from "../../../packages/backend-cursor/src/serverEntry.ts";

import backendFx from "../../../packages/backend-fx/src/serverEntry.ts";
import backendGrok from "../../../packages/backend-grok/src/serverEntry.ts";
import backendOmp from "../../../packages/backend-omp/src/serverEntry.ts";
import backendPi from "../../../packages/backend-pi/src/serverEntry.ts";

import backendOpencode from "../../../packages/backend-opencode/src/serverEntry.ts";

import harnessRuntime from "../../../packages/harness-runtime/src/packageEntry.ts";

import opencode from "../../../packages/opencode/src/serverEntry.ts";

import sessionImport from "../../../packages/session-import/src/serverEntry.ts";

type Descriptor = Omit<PackageDescriptorDto, "id">;

const entry = (
  id: string,
  descriptor: Descriptor,
  factory: ServerPackageFactory,
): ServerPackageRegistration => ({ id, descriptor: { id, ...descriptor }, factory });

export const desktopServerPackages = [
  entry("backend-acp", {"name": "ACP harnesses", "description": "Shared Agent Client Protocol transport and runtime", "core": false, "enabled": true, "icon": "network", "hasSettings": false}, backendAcp),
  entry("backend-claude", {"name": "Claude Code harness", "description": "Claude Code through its Agent SDK", "core": false, "enabled": true, "icon": "assist", "hasSettings": false}, backendClaude),
  entry("backend-codex", {"name": "Codex harness", "description": "Native Codex App Server execution", "core": false, "enabled": true, "icon": "code", "hasSettings": false}, backendCodex),
  entry("backend-commandcode", {"name": "Command Code harness", "description": "Command Code through its official headless event stream and native mod bridge", "core": false, "enabled": true, "icon": "command", "hasSettings": false}, backendCommandCode),
  entry("backend-cursor", {"name": "Cursor harness", "description": "Cursor through shared ACP", "core": false, "enabled": true, "icon": "pointer", "hasSettings": false}, backendCursor),
  entry("backend-fx", {"name": "fx harness", "description": "fx through shared ACP", "core": false, "enabled": true, "icon": "command", "hasSettings": false}, backendFx),
  entry("backend-grok", {"name": "Grok Build harness", "description": "Grok Build through its native ACP stdio agent", "core": false, "enabled": true, "icon": "assist", "hasSettings": false}, backendGrok),
  entry("backend-omp", {"name": "OMP harness", "description": "oh-my-pi through its native ACP transport", "core": false, "enabled": true, "icon": "command", "hasSettings": false}, backendOmp),
  entry("backend-pi", {"name": "Pi harness", "description": "Detect Pi and report native RPC integration readiness", "core": false, "enabled": true, "icon": "command", "hasSettings": false}, backendPi),
  entry("backend-opencode", {"name": "OpenCode harness", "description": "Managed OpenCode HTTP and SSE runtime", "core": true, "enabled": true, "icon": "terminal", "hasSettings": false}, backendOpencode),
  entry("browser", { name: "Browser", description: "A shared internal browser for users, agents, and element context.", core: false, enabled: true, settingsGroup: "Engineering", icon: "globe", hasSettings: false }, browser),
  entry("chat-workspace", { name: "Chat Workspace", description: "Use the AI chats you already have, directly alongside your work.", core: false, enabled: true, settingsGroup: "Workspace", icon: "chat", hasSettings: true }, chatWorkspace),
  entry("commands", { name: "Commands", description: "Reusable project command definitions.", core: false, enabled: true, settingsGroup: "Engineering", icon: "command", hasSettings: true }, commands),
  entry("custom-action", { name: "Custom Action", description: "Configurable icon widgets that run project commands.", core: false, enabled: true, settingsGroup: "Customize", icon: "play", hasSettings: false }, customAction),
  entry("dictation", { name: "Voice & Dictation", description: "Speech-to-text dictation and spoken replies.", core: false, enabled: true, settingsGroup: "Workspace", icon: "mic", hasSettings: true }, dictation),
  entry("editor", { name: "Editor", description: "Text and code editing runtime for the workbench.", core: true, enabled: true, icon: "edit", hasSettings: false }, editor),
  entry("example-feature", { name: "Example Feature", description: "Proof-of-concept package registered via package discovery.", core: false, enabled: true, settingsGroup: "Customize", icon: "flask", hasSettings: false }, exampleFeature),
  entry("files", { name: "Files", description: "Workspace file access and attachments.", core: true, enabled: true, icon: "files", hasSettings: false }, files),
  entry("fusion", { name: "Fusion", description: "Synthesize multiple model responses.", core: false, enabled: true, settingsGroup: "Engineering", icon: "combine", hasSettings: false }, fusion),
  entry("git", { name: "Git", description: "Source control status, diffs, commits, and worktrees.", core: false, enabled: true, settingsGroup: "Engineering", icon: "git", hasSettings: true }, git),
  entry("gitlab", { name: "GitLab", description: "GitLab issues, merge requests and pipelines.", core: false, enabled: true, settingsGroup: "Engineering", icon: "gitlab", hasSettings: false }, gitlab),
  entry("github", { name: "GitHub", description: "GitHub pull request and check integration.", core: false, enabled: true, settingsGroup: "Engineering", icon: "github", hasSettings: false }, github),
  entry("goals", { name: "Goals", description: "Goal tracking and completion audits.", core: false, enabled: true, settingsGroup: "Workspace", icon: "target", hasSettings: false }, goals),
  entry("handoff", { name: "Handoff", description: "Build context bundles and import chat results into Polyth sessions.", core: false, enabled: true, settingsGroup: "Workspace", icon: "handoff", hasSettings: false }, handoff),
  entry("harness-runtime", {"name": "Harnesses", "description": "Choose the execution engine for a canonical session", "core": true, "enabled": true, "icon": "cpu", "hasSettings": true, "settingsGroup": "Engineering"}, harnessRuntime),
  entry("home-assistant", { name: "Home Assistant", description: "Home Assistant entities and controls.", core: false, enabled: false, settingsGroup: "Customize", icon: "home", hasSettings: true }, homeAssistant),
  entry("hotkeys", { name: "Shortcuts", description: "Keyboard shortcut configuration and runtime registration.", core: true, enabled: true, settingsGroup: "Workspace", icon: "keyboard", hasSettings: true }, hotkeys),
  entry("knowledge", { name: "Knowledge", description: "Project notes, plans, and reusable context.", core: false, enabled: true, settingsGroup: "Workspace", icon: "knowledge", hasSettings: false }, knowledge),
  entry("markets", { name: "Markets", description: "Fast market research, watchlists, and agent-ready financial context.", core: false, enabled: true, settingsGroup: "Workspace", icon: "chart", hasSettings: false }, markets),
  entry("models", { name: "Models", description: "Harness-qualified model selection, presentation, and favorites.", core: true, enabled: true, settingsGroup: "Engineering", icon: "database", hasSettings: false }, models),
  entry("multirun", { name: "Multirun", description: "Run prompts across multiple models.", core: false, enabled: true, settingsGroup: "Engineering", icon: "layers", hasSettings: false }, multirun),
  entry("opencode", {"name": "OpenCode", "description": "OpenCode-native roles and runtime configuration surfaces.", "core": true, "enabled": true, "icon": "braces", "hasSettings": false}, opencode),
  entry("permissions", { name: "Permissions", description: "Tool permission review and policy enforcement.", core: true, enabled: true, icon: "shield", hasSettings: false }, permissions),
  entry("plugins", { name: "Plugins", description: "Managed plugin installation and configuration.", core: false, enabled: true, settingsGroup: "Customize", icon: "plugin", hasSettings: true }, plugins),
  entry("schedule", { name: "Schedule", description: "Schedule recurring and one-time agent tasks.", core: false, enabled: true, settingsGroup: "Engineering", icon: "schedule", hasSettings: false }, schedule),
  entry("secure-safe", { name: "Secure Safe", description: "Write-only credential handles and secret policy.", core: false, enabled: true, settingsGroup: "Engineering", icon: "lock", hasSettings: true }, secureSafe),
  entry("session-import", {"name": "Session Import", "description": "Import a native conversation as a canonical Snapshot", "core": false, "enabled": true, "icon": "import", "hasSettings": false}, sessionImport),
  entry("ssh", { name: "SSH Remotes", description: "SSH connections and remote projects whose agent runs on the host.", core: false, enabled: true, settingsGroup: "Engineering", icon: "server", hasSettings: true }, ssh),
  entry("task-trackers", { name: "Jira & Trello", description: "Jira and Trello boards, tasks, agent handoffs, and status updates.", core: false, enabled: true, settingsGroup: "Engineering", icon: "tasks", hasSettings: false }, taskTrackers),
  entry("terminal", { name: "Terminal", description: "Project-scoped terminal sessions.", core: false, enabled: true, settingsGroup: "Engineering", icon: "terminal", hasSettings: false }, terminal),
  entry("tunnel", { name: "Polyth Link", description: "QR pairing, authenticated remote access, and device grants.", core: true, enabled: true, hasSettings: true, settingsGroup: "System", icon: "qr" }, tunnel),
  entry("usage", { name: "Usage", description: "Model quota and usage reporting.", core: false, enabled: true, settingsGroup: "Workspace", icon: "usage", hasSettings: true }, usage),
  entry("walkthrough", { name: "Walkthrough", description: "Generate and review code walkthroughs.", core: false, enabled: true, settingsGroup: "Engineering", icon: "route", hasSettings: false }, walkthrough),
  entry("workflow", { name: "Workflows", description: "Orchestrate multi-agent DAG pipelines.", core: false, enabled: true, settingsGroup: "Engineering", icon: "workflow", hasSettings: false }, workflow),
] as const satisfies readonly ServerPackageRegistration[];
