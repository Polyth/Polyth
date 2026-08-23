import type { PackageOnboardingTour } from "../types.ts";

export const GIT_TOUR: PackageOnboardingTour = {
  packageId: "git",
  title: "Git",
  steps: [
    {
      id: "overview",
      title: "Source control, in session",
      body: "The Git package keeps an eye on your worktree while agents work: branches, pending changes, and reviews without leaving the conversation.",
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "pending-changes",
      title: "Pending changes at a glance",
      body: "A session footer widget counts changed files and lines right above the composer, so you always know how big the diff has grown.",
      highlight: "Workspace files changed",
      media: { kind: "pattern", pattern: "rays" },
    },
  ],
};
