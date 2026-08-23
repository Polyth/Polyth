import type { PackageOnboardingTour } from "../types.ts";

// These tours belong to core settings pages or package surfaces that do not
// have a web installer. They stay available for the lifetime of the app.
export const BUILTIN_TOURS: readonly PackageOnboardingTour[] = [
  {
    packageId: "session",
    title: "Session Runtime",
    steps: [
      {
        id: "overview",
        title: "Every turn has a durable history",
        body: "Session Runtime records messages, tool activity, questions, and results as an ordered event stream, then rebuilds the conversation from that history.",
        media: { kind: "pattern", pattern: "waveform" },
      },
      {
        id: "chat",
        title: "Work from the session surface",
        body: "Open a project session to talk with the agent and follow live progress. Mod+N starts a new session, Mod+I focuses the composer, and Mod+Shift+F searches session history.",
        highlight: "Chat",
        media: { kind: "pattern", pattern: "tiles" },
      },
    ],
  },
  {
    packageId: "files",
    title: "Files",
    steps: [
      {
        id: "overview",
        title: "Browse and edit the workspace",
        body: "Files keeps project paths, attachments, and editor operations scoped to the active workspace.",
        media: { kind: "pattern", pattern: "branches" },
      },
      {
        id: "project-files",
        title: "Keep source beside the conversation",
        body: "Toggle the Project files pane with Mod+Shift+E to browse and edit without leaving the active chat, or press Mod+P to search files from anywhere.",
        highlight: "Project files",
        media: { kind: "pattern", pattern: "tiles" },
      },
      {
        id: "project-map",
        title: "See the project at a glance",
        body: "Add the folder overview to a canvas when you need a compact map of the repository.",
        highlight: "Project Map",
        media: { kind: "pattern", pattern: "rays" },
      },
    ],
  },
  {
    packageId: "projects",
    title: "Projects",
    steps: [
      {
        id: "overview",
        title: "Keep work isolated by project",
        body: "Projects connect a folder to its sessions, defaults, and workspace layout. Removing one from Polyth leaves the folder on disk.",
        media: { kind: "pattern", pattern: "branches" },
      },
      {
        id: "default-model",
        title: "Choose a project default",
        body: "Override the global model for new sessions in just this project.",
        highlight: "Default model",
        media: { kind: "pattern", pattern: "orbit" },
      },
      {
        id: "canvas",
        title: "Start with the right workspace",
        body: "Pick a canvas layout and suggested widgets that fit how this project is used.",
        highlight: "Canvas setup",
        media: { kind: "pattern", pattern: "tiles" },
      },
    ],
  },
  {
    packageId: "behavior",
    title: "Behavior",
    steps: [
      {
        id: "overview",
        title: "Set workspace-wide working rules",
        body: "Behavior controls safety prompts, editor flow, and instructions applied to every agent turn.",
        media: { kind: "pattern", pattern: "rays" },
      },
      {
        id: "instructions",
        title: "Give every agent the same guidance",
        body: "Add coding conventions, review standards, or tone once, then save and apply them across sessions.",
        highlight: "Global instructions",
        media: { kind: "pattern", pattern: "waveform" },
      },
      {
        id: "autosave",
        title: "Choose how edits are saved",
        body: "Editor autosave writes after a short pause and uses revision checks to avoid overwriting disk changes.",
        highlight: "Editor autosave",
        media: { kind: "pattern", pattern: "orbit" },
      },
    ],
  },
  {
    packageId: "permissions",
    title: "Permissions",
    steps: [
      {
        id: "overview",
        title: "Review sensitive tool actions",
        body: "Permissions pauses work when an agent needs approval and shows a redacted preview with the action’s risk level.",
        media: { kind: "pattern", pattern: "rays" },
      },
      {
        id: "decision",
        title: "Approve only the scope you intend",
        body: "Allow once approves a single action, Always remembers it for this session or this project, and Deny rejects the request.",
        highlight: "Allow once",
        media: { kind: "pattern", pattern: "branches" },
      },
      {
        id: "auto-approve",
        title: "Skip prompts for trusted sessions",
        body: "The Auto Approve toggle in the session header turns on automatic approval for the current or next session — switch it off to review each action again.",
        highlight: "Auto Approve",
        media: { kind: "pattern", pattern: "orbit" },
      },
    ],
  },
  {
    packageId: "notifications",
    title: "Notifications",
    steps: [
      {
        id: "overview",
        title: "Know when a session needs you",
        body: "Notifications can alert you when turns finish, fail, ask a question, request permission, or complete delegated work.",
        media: { kind: "pattern", pattern: "waveform" },
      },
      {
        id: "kinds",
        title: "Choose the events that matter",
        body: "Enable each event type independently so routine activity stays quiet.",
        highlight: "Notify about",
        media: { kind: "pattern", pattern: "tiles" },
      },
      {
        id: "visibility",
        title: "Control when alerts appear",
        body: "Limit desktop alerts to times when the tab is hidden, while keeping active sessions quiet.",
        highlight: "Only when hidden",
        media: { kind: "pattern", pattern: "orbit" },
      },
    ],
  },
  {
    packageId: "appearance",
    title: "Appearance",
    steps: [
      {
        id: "overview",
        title: "Make the workspace comfortable",
        body: "Appearance changes theme, typography, density, sizing, and corner treatment immediately in this browser.",
        media: { kind: "pattern", pattern: "rays" },
      },
      {
        id: "mode",
        title: "Follow the system or choose a mode",
        body: "Use system, dark, or light rendering independently from the selected color palette.",
        highlight: "Appearance",
        media: { kind: "pattern", pattern: "orbit" },
      },
      {
        id: "theme",
        title: "Pick or import a palette",
        body: "Preview bundled themes on hover or import a custom theme as JSON.",
        highlight: "Theme",
        media: { kind: "pattern", pattern: "tiles" },
      },
    ],
  },
  {
    packageId: "general",
    title: "General",
    steps: [
      {
        id: "overview",
        title: "Set browser-local basics",
        body: "General holds the small application preferences that shape labels and everyday navigation.",
        media: { kind: "pattern", pattern: "tiles" },
      },
      {
        id: "name",
        title: "Name your workspace",
        body: "Choose the product name shown in the sidebar and window chrome.",
        highlight: "Product name",
        media: { kind: "pattern", pattern: "rays" },
      },
      {
        id: "time",
        title: "Make activity times readable",
        body: "Switch session activity between relative labels and clock times.",
        highlight: "Relative timestamps",
        media: { kind: "pattern", pattern: "waveform" },
      },
    ],
  },
  {
    packageId: "chat",
    title: "Chat",
    steps: [
      {
        id: "overview",
        title: "Tune the conversation",
        body: "Chat controls message layout, reasoning display, copy behavior, and how follow-ups are delivered.",
        media: { kind: "pattern", pattern: "waveform" },
      },
      {
        id: "follow-up",
        title: "Decide what Enter does mid-turn",
        body: "Steer redirects the active turn, Queue waits for it, and Interrupt stops it before sending.",
        highlight: "While the agent is working",
        media: { kind: "pattern", pattern: "branches" },
      },
      {
        id: "enter",
        title: "Choose your send gesture",
        body: "Keep Enter as send, or use it for new lines and send with Mod+Enter. In the composer, / expands commands, # expands snippets, @ attaches files — Mod+I focuses it from anywhere.",
        highlight: "Send on Enter",
        media: { kind: "pattern", pattern: "orbit" },
      },
    ],
  },
  {
    packageId: "sessions",
    title: "Sessions",
    steps: [
      {
        id: "overview",
        title: "Start every session consistently",
        body: "Sessions defines the default model, role, thinking level, and lightweight model used when a project has no override.",
        media: { kind: "pattern", pattern: "branches" },
      },
      {
        id: "model",
        title: "Set the global model fallback",
        body: "New sessions (Mod+N) inherit this model unless their project supplies a different one.",
        highlight: "Default Model",
        media: { kind: "pattern", pattern: "orbit" },
      },
      {
        id: "retention",
        title: "Keep history on your terms",
        body: "Choose when idle completed sessions become eligible, then archive them with an explicit cleanup.",
        highlight: "Retention Period",
        media: { kind: "pattern", pattern: "rays" },
      },
    ],
  },
  {
    packageId: "shortcuts",
    title: "Shortcuts",
    steps: [
      {
        id: "overview",
        title: "Put common actions on the keyboard",
        body: "Shortcuts collects core and plugin-provided actions in one editable keymap. Defaults include Mod+K for the command palette, Mod+P to search files, and Mod+J for the terminal.",
        media: { kind: "pattern", pattern: "tiles" },
      },
      {
        id: "capture",
        title: "Record a new binding",
        body: "Click any displayed key combination and press the replacement. Conflicts remain visible until you resolve them.",
        highlight: "Click to change",
        media: { kind: "pattern", pattern: "waveform" },
      },
      {
        id: "reset",
        title: "Return to known defaults",
        body: "Restore every bundled binding in one action if your keymap becomes crowded.",
        highlight: "Reset all to defaults →",
        media: { kind: "pattern", pattern: "orbit" },
      },
    ],
  },
  {
    packageId: "access",
    title: "Access",
    steps: [
      {
        id: "overview",
        title: "Protect the local application",
        body: "Access reports whether the server’s UI password gate is active without exposing the password itself.",
        media: { kind: "pattern", pattern: "rays" },
      },
      {
        id: "devices",
        title: "Review signed-in devices",
        body: "See remembered browser sessions and revoke any device that should no longer connect.",
        highlight: "Remembered devices",
        media: { kind: "pattern", pattern: "tiles" },
      },
      {
        id: "sign-out",
        title: "Revoke every session",
        body: "Sign out all devices, including the current one, when access needs a clean reset.",
        highlight: "Sign out everywhere",
        media: { kind: "pattern", pattern: "branches" },
      },
    ],
  },
  {
    packageId: "about",
    title: "About",
    steps: [
      {
        id: "overview",
        title: "Inspect this Polyth server",
        body: "About shows the running version, configured addresses, data location, and available server capabilities.",
        media: { kind: "pattern", pattern: "orbit" },
      },
      {
        id: "url",
        title: "Copy the configured address",
        body: "Use the server’s explicit application URL when opening this instance elsewhere.",
        highlight: "Application URL",
        media: { kind: "pattern", pattern: "branches" },
      },
      {
        id: "capabilities",
        title: "Check what the server supports",
        body: "The capability list gives a quick view of the features available in this runtime.",
        highlight: "Capabilities",
        media: { kind: "pattern", pattern: "tiles" },
      },
    ],
  },
  {
    packageId: "terminal",
    title: "Terminal",
    steps: [
      {
        id: "overview",
        title: "Run commands beside the agent",
        body: "Terminal opens project-scoped shell sessions in a workspace pane and reconnects to live terminals with their recent output.",
        media: { kind: "pattern", pattern: "waveform" },
      },
      {
        id: "surface",
        title: "Keep the shell close",
        body: "Toggle the Terminal pane with Mod+J without replacing Chat, then switch among independently running tabs.",
        highlight: "Terminal",
        media: { kind: "pattern", pattern: "tiles" },
      },
      {
        id: "tabs",
        title: "Create another shell",
        body: "Start additional terminals for servers, tests, or one-off commands and rename each tab as needed.",
        highlight: "New terminal",
        media: { kind: "pattern", pattern: "branches" },
      },
    ],
  },
  {
    packageId: "preview",
    title: "Preview",
    steps: [
      {
        id: "overview",
        title: "See the running project",
        body: "Preview starts or adopts a project development server and keeps its rendered output beside the conversation.",
        media: { kind: "pattern", pattern: "rays" },
      },
      {
        id: "start",
        title: "Launch from the workspace",
        body: "Start the configured preview, switch among discovered addresses, and stop it when the run is finished.",
        highlight: "Start",
        media: { kind: "pattern", pattern: "orbit" },
      },
      {
        id: "inspect",
        title: "Watch runtime details",
        body: "Open the inspector to review the preview address, status, and browser diagnostics when available.",
        highlight: "Inspector",
        media: { kind: "pattern", pattern: "tiles" },
      },
    ],
  },
  {
    packageId: "browser",
    title: "Browser",
    steps: [
      {
        id: "overview",
        title: "Share a controlled browser",
        body: "Browser gives you and the agent the same server-owned page context, including navigation, clicks, typing, and live frames.",
        media: { kind: "pattern", pattern: "orbit" },
      },
      {
        id: "open",
        title: "Upgrade a preview to browser control",
        body: "Open a controlled session from Preview when a browser engine is available.",
        highlight: "Browser",
        media: { kind: "pattern", pattern: "branches" },
      },
      {
        id: "observe",
        title: "Capture useful page context",
        body: "Read visible text and accessibility details, or mark an area and send the annotated capture to chat.",
        highlight: "Snapshot",
        media: { kind: "pattern", pattern: "rays" },
      },
    ],
  },
  {
    packageId: "goals",
    title: "Goals",
    steps: [
      {
        id: "overview",
        title: "Keep a session aimed at an objective",
        body: "Goals attaches a concrete outcome and lets the auditor continue work until it is done, stuck, stopped, or out of budget.",
        media: { kind: "pattern", pattern: "orbit" },
      },
      {
        id: "attach",
        title: "Define the outcome",
        body: "Attach an objective to the active session, then track its token budget and continuation count.",
        highlight: "Attach goal",
        media: { kind: "pattern", pattern: "rays" },
      },
      {
        id: "audit",
        title: "Follow every completion check",
        body: "The auditor records each keep, done, or stuck verdict with its reason.",
        highlight: "Audit trail",
        media: { kind: "pattern", pattern: "waveform" },
      },
    ],
  },
  {
    packageId: "multirun",
    title: "Multirun",
    steps: [
      {
        id: "overview",
        title: "Compare models on the same prompt",
        body: "Multirun sends one prompt to several selected models in parallel and displays the responses side by side.",
        media: { kind: "pattern", pattern: "branches" },
      },
      {
        id: "models",
        title: "Choose the comparison set",
        body: "Filter the available catalog, select up to three models, and optionally pick the agent role the runs share before pressing Run.",
        highlight: "Filter models…",
        media: { kind: "pattern", pattern: "tiles" },
      },
      {
        id: "pick",
        title: "Make one response canonical",
        body: "Select the strongest completed result so the session records which run won.",
        highlight: "Pick this run",
        media: { kind: "pattern", pattern: "rays" },
      },
    ],
  },
  {
    packageId: "workflow",
    title: "Workflows",
    steps: [
      {
        id: "overview",
        title: "Coordinate dependent agent work",
        body: "Workflows builds a directed graph of roles, then runs each ready layer in parallel while preserving a parent-session log.",
        media: { kind: "pattern", pattern: "branches" },
      },
      {
        id: "nodes",
        title: "Build the agent graph",
        body: "Give each node a role, prompt, model, and dependencies. Cycle checks keep the graph runnable.",
        highlight: "+ Node",
        media: { kind: "pattern", pattern: "tiles" },
      },
      {
        id: "run",
        title: "Control execution",
        body: "Choose how context flows, whether permissions are automatic or manual, and how many nodes may run together.",
        highlight: "Run workflow",
        media: { kind: "pattern", pattern: "orbit" },
      },
    ],
  },
  {
    packageId: "fusion",
    title: "Fusion",
    steps: [
      {
        id: "overview",
        title: "Synthesize several model drafts",
        body: "Fusion asks selected models the same question, weighs their contributions, and produces one combined answer.",
        media: { kind: "pattern", pattern: "rays" },
      },
      {
        id: "models",
        title: "Pick the contributors",
        body: "Filter the model catalog, choose the perspectives you want, then start synthesis.",
        highlight: "Fuse",
        media: { kind: "pattern", pattern: "orbit" },
      },
      {
        id: "disagreements",
        title: "Keep conflicting views visible",
        body: "Review attribution weights and the points where contributors did not agree.",
        highlight: "Disagreements",
        media: { kind: "pattern", pattern: "waveform" },
      },
    ],
  },
  {
    packageId: "walkthrough",
    title: "Walkthrough",
    steps: [
      {
        id: "overview",
        title: "Review changes one step at a time",
        body: "Walkthrough turns session file edits into an ordered review with diffs and explanations.",
        media: { kind: "pattern", pattern: "tiles" },
      },
      {
        id: "session",
        title: "Decide on each edit",
        body: "Move through recorded file changes and approve, reject, or skip each pending step.",
        highlight: "Session steps",
        media: { kind: "pattern", pattern: "branches" },
      },
      {
        id: "generate",
        title: "Generate a fresh guide",
        body: "Use the configured walkthrough model when you want an explanatory review of current changes.",
        highlight: "Generate",
        media: { kind: "pattern", pattern: "rays" },
      },
    ],
  },
  {
    packageId: "schedule",
    title: "Schedule",
    steps: [
      {
        id: "overview",
        title: "Run prompts at the right time",
        body: "Schedule creates one-time, interval, or cron tasks and records each run while the server is available.",
        media: { kind: "pattern", pattern: "waveform" },
      },
      {
        id: "cadence",
        title: "Choose a precise cadence",
        body: "Set a local date, repeat every number of minutes, or use cron with an explicit time zone.",
        highlight: "Once at",
        media: { kind: "pattern", pattern: "orbit" },
      },
      {
        id: "overlap",
        title: "Handle overlapping runs safely",
        body: "Skip, queue, or run in parallel when the prior task has not finished.",
        highlight: "If still running:",
        media: { kind: "pattern", pattern: "branches" },
      },
    ],
  },
  {
    packageId: "widgets",
    title: "Widgets & Layout",
    steps: [
      {
        id: "overview",
        title: "Put tools where you use them",
        body: "Widgets & Layout arranges workspace tools, composer actions, and compact status controls without changing package code.",
        media: { kind: "pattern", pattern: "tiles" },
      },
      {
        id: "tools",
        title: "Arrange workspace tools",
        body: "Move available capabilities among the primary header, More tools, and the technical menu.",
        highlight: "Focus header",
        media: { kind: "pattern", pattern: "branches" },
      },
      {
        id: "actions",
        title: "Choose compact actions",
        body: "Add or hide buttons around the composer and application headers. Changes save automatically.",
        highlight: "Composer actions",
        media: { kind: "pattern", pattern: "orbit" },
      },
    ],
  },
];
