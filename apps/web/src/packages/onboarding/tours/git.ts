import type { PackageOnboardingTour } from "../types.ts";

export const GIT_TOUR: PackageOnboardingTour = {
  packageId: "git",
  title: "Git",
  steps: [
    {
      id: "overview",
      title: "Source control, in session",
      body: "Git keeps the active project’s repository beside the conversation: status, staging, commits, branches, worktrees, and stashes without leaving the workspace.",
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "source-control",
      title: "Work the repository from a pane",
      body: "Toggle the Source control pane with Mod+Shift+G. Stage or unstage files, write a commit message, review diffs in Unified or Split layout, and manage branches, worktrees, and stashes.",
      highlight: "Source control",
      highlightWhere: "pane",
      media: { kind: "pattern", pattern: "tiles" },
    },
    {
      id: "pending-changes",
      title: "Pending changes at a glance",
      body: "The Workspace files changed widget sits just above the composer, counting changed files and added or removed lines while agents work.",
      highlight: "Workspace files changed",
      highlightWhere: "composer",
      media: { kind: "pattern", pattern: "rays" },
    },
    {
      id: "personas",
      title: "Commit as the right identity",
      body: "On the Git settings page, save Git personas (label, author name, email) and apply one to write repository-local commit identity. The Branch name template accepts {slug} and {date}.",
      highlight: "Git personas",
      media: { kind: "pattern", pattern: "orbit" },
    },
  ],
};
