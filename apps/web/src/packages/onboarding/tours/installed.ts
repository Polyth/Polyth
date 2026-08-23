import type { PackageOnboardingTour } from "../types.ts";

export const MODELS_TOUR: PackageOnboardingTour = {
  packageId: "models",
  title: "Providers & Models",
  steps: [
    {
      id: "overview",
      title: "Control the model catalog",
      body: "Providers & Models shows what the backend discovered and controls which providers and models appear throughout Polyth.",
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "scope",
      title: "Focus on usable providers",
      body: "Switch between connected providers and the full catalog, then search or filter before changing visibility.",
      highlight: "Connected",
      media: { kind: "pattern", pattern: "tiles" },
    },
    {
      id: "favorites",
      title: "Keep preferred models first",
      body: "Star the models you reach for most often so pickers order them ahead of the rest.",
      highlight: "Add favorite",
      media: { kind: "pattern", pattern: "rays" },
    },
  ],
};

export const AGENTS_TOUR: PackageOnboardingTour = {
  packageId: "agents",
  title: "Roles",
  steps: [
    {
      id: "overview",
      title: "Shape how each role works",
      body: "Roles configures an agent’s instructions, model, and whether it leads sessions or handles delegated tasks.",
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "roles",
      title: "Tune a reported role",
      body: "Edit the usage mode, provider and model, or system prompt for any configurable role.",
      highlight: "Edit role",
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "profiles",
      title: "Bundle repeatable choices",
      body: "Agent profiles combine a model, role, and options into one validated selection you can reuse.",
      highlight: "Agent profiles",
      media: { kind: "pattern", pattern: "tiles" },
    },
  ],
};

export const USAGE_TOUR: PackageOnboardingTour = {
  packageId: "usage",
  title: "Usage",
  steps: [
    {
      id: "overview",
      title: "Understand model activity and cost",
      body: "Usage combines session token and cost totals with provider quota snapshots in one dashboard.",
      media: { kind: "pattern", pattern: "waveform" },
    },
    {
      id: "range",
      title: "Compare the period that matters",
      body: "Review spend, tokens, and request trends over seven, thirty, or ninety days.",
      highlight: "Usage Overview",
      media: { kind: "pattern", pattern: "rays" },
    },
    {
      id: "providers",
      title: "Watch provider health",
      body: "Inspect quota windows, pace, account freshness, and which providers should appear in widgets.",
      highlight: "Providers",
      media: { kind: "pattern", pattern: "orbit" },
    },
  ],
};

export const GITHUB_TOUR: PackageOnboardingTour = {
  packageId: "github",
  title: "GitHub",
  steps: [
    {
      id: "overview",
      title: "Keep repository work in view",
      body: "GitHub surfaces project pull requests, issues, checks, and the pull request associated with the current branch.",
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "summary",
      title: "Add the active pull request to your canvas",
      body: "The summary widget links to the current pull request and shows its file and line totals.",
      highlight: "Current pull request",
      media: { kind: "pattern", pattern: "tiles" },
    },
    {
      id: "metrics",
      title: "Show only useful diff metrics",
      body: "Choose whether the widget includes changed files, additions, and removals.",
      highlight: "Changed files",
      media: { kind: "pattern", pattern: "rays" },
    },
  ],
};

export const KNOWLEDGE_TOUR: PackageOnboardingTour = {
  packageId: "knowledge",
  title: "Knowledge",
  steps: [
    {
      id: "overview",
      title: "Keep durable project context",
      body: "Knowledge stores notes, plans, and reusable context with the project instead of burying it in one conversation.",
      media: { kind: "pattern", pattern: "tiles" },
    },
    {
      id: "tracks",
      title: "Execute a saved feature spec",
      body: "Tracks turns a specification into tested, atomic steps that can be followed from the workspace rail.",
      highlight: "Tracks",
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "notes",
      title: "Keep reference material visible",
      body: "Add the project knowledge panel to a canvas when notes and plans should stay beside active work.",
      highlight: "Notes / Memory",
      media: { kind: "pattern", pattern: "orbit" },
    },
  ],
};

export const HOME_ASSISTANT_TOUR: PackageOnboardingTour = {
  packageId: "home-assistant",
  title: "Home Assistant",
  steps: [
    {
      id: "overview",
      title: "Bring selected home controls into the workspace",
      body: "Home Assistant reads configured entity state and provides focused controls for lights, climate, sensors, and connection health.",
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "connection",
      title: "Connect without exposing the token",
      body: "Set the server address and token environment name. The long-lived token is write-only.",
      highlight: "Home Assistant URL",
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "widgets",
      title: "Choose the controls you need",
      body: "Place a connection card, entity state, light toggle, or climate panel in the canvas.",
      highlight: "Light control",
      media: { kind: "pattern", pattern: "rays" },
    },
  ],
};

export const SECURE_SAFE_TOUR: PackageOnboardingTour = {
  packageId: "secure-safe",
  title: "Secure Safe",
  steps: [
    {
      id: "overview",
      title: "Reference credentials without revealing them",
      body: "Secure Safe stores values behind reusable handles. Agents may request a handle, but cannot read the stored credential.",
      media: { kind: "pattern", pattern: "rays" },
    },
    {
      id: "handles",
      title: "Audit the handles that exist",
      body: "Review labels, handle names, and purposes without returning any secret value.",
      highlight: "Saved handles",
      media: { kind: "pattern", pattern: "tiles" },
    },
    {
      id: "add",
      title: "Submit a value once",
      body: "Create a clear handle and purpose, then enter the credential. The value is cleared immediately after submission.",
      highlight: "Add credential",
      media: { kind: "pattern", pattern: "orbit" },
    },
  ],
};

export const MCP_TOUR: PackageOnboardingTour = {
  packageId: "mcp",
  title: "MCP",
  steps: [
    {
      id: "overview",
      title: "Connect Model Context Protocol servers",
      body: "MCP manages stdio and HTTP tool servers applied to the backend runtime, with write-only environment and header secrets.",
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "add",
      title: "Configure a server directly",
      body: "Add a transport, command or URL, and the secret names it needs.",
      highlight: "+ MCP server",
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "import",
      title: "Preview existing configuration",
      body: "Paste a compatible mcpServers block, inspect the mapped entries, and import only after the preview is valid.",
      highlight: "Import JSON…",
      media: { kind: "pattern", pattern: "tiles" },
    },
  ],
};

export const COMMANDS_TOUR: PackageOnboardingTour = {
  packageId: "commands",
  title: "Commands & Snippets",
  steps: [
    {
      id: "overview",
      title: "Save prompts you use repeatedly",
      body: "Commands expands named prompts from the composer, while snippets insert reusable text inline.",
      media: { kind: "pattern", pattern: "waveform" },
    },
    {
      id: "commands",
      title: "Create slash commands",
      body: "Define a project or user command as markdown, including $ARGUMENTS for text supplied after its name.",
      highlight: "Slash commands",
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "snippets",
      title: "Insert saved text with an alias",
      body: "Create # aliases for project-specific or general text that can expand anywhere in a message.",
      highlight: "Snippets",
      media: { kind: "pattern", pattern: "tiles" },
    },
  ],
};

export const PLUGINS_TOUR: PackageOnboardingTour = {
  packageId: "plugins",
  title: "Plugins",
  steps: [
    {
      id: "overview",
      title: "Extend the workspace deliberately",
      body: "Plugins can contribute widgets, commands, tools, settings, and workspace surfaces from trusted npm or local sources.",
      media: { kind: "pattern", pattern: "tiles" },
    },
    {
      id: "library",
      title: "Inspect what is installed",
      body: "Review status, contribution counts, permissions, and logs before enabling or updating an extension.",
      highlight: "Plugin library",
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "install",
      title: "Add an explicit source",
      body: "Install a versioned npm package or a folder from the trusted plugin directory.",
      highlight: "Install",
      media: { kind: "pattern", pattern: "rays" },
    },
  ],
};

export const INTEGRATIONS_TOUR: PackageOnboardingTour = {
  packageId: "integrations",
  title: "Integrations",
  steps: [
    {
      id: "overview",
      title: "Connect through local service tools",
      body: "Integrations reports external-service readiness through installed CLIs, without storing their tokens in Polyth.",
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "github",
      title: "Verify GitHub readiness",
      body: "Check that the GitHub CLI is installed, authenticated, and pointed at a repository for the active project.",
      highlight: "GitHub CLI",
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "view",
      title: "Continue into repository work",
      body: "When a repository is detected, open the full issues and pull request view from the integration status.",
      highlight: "Open GitHub view →",
      media: { kind: "pattern", pattern: "tiles" },
    },
  ],
};
