import type { WorkbenchProfileDefinition } from "@polyth/web-sdk";

// IDE mode is a primary workbench profile, not a new surface: it reuses the
// Files surface (tree + editor) and the chat. The host owns the geometry; the
// profile only declares the arrangement through presentation hints.
export const IDE_PROFILE = {
  id: "ide",
  label: "IDE",
  description: "Files and editor on the left, sessions and chat on the right.",
  order: 12,
  projectAffinity: { directions: ["engineering"], recommended: true },
  defaultLayout: {
    // The host's ordinary focused split (chat primary, work surface at the
    // end) laid out mirrored: Files first, then chat, then the sidebar.
    surfaces: [
      { surface: "session", region: "primary", active: true },
      { surface: "files", region: "end", active: true },
    ],
  },
  presentation: {
    text: "code",
    navigation: "primary",
    focused: true,
    // The wide shell lays out mirrored while IDE mode is active: sidebar and
    // project rail at the end edge, launcher strip and Files at the start;
    // radii, resize handles and window motion follow (WorkbenchShellHints).
    mirrored: true,
    splitSurfaces: ["session", "files"],
    // Files is the flexible primary column; chat is a fixed-width companion.
    companionWidth: { min: 360, target: 440, max: 560 },
    // Below this window the session sidebar rests as the project rail.
    sidebarRailBelow: 1600,
    // Files keeps every file the active chat edited open (each chat its own
    // tabs), opens new edits as they land and reloads clean agent-changed
    // editors. On by default for every profile; IDE states it explicitly.
    openSessionEdits: true,
  },
} satisfies WorkbenchProfileDefinition;
