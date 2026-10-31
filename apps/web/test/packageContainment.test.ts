import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const packagesDir = join(root, "packages");
const webSrcDir = join(root, "apps/web/src");

interface PackageManifest {
  name?: string;
  polyth?: {
    serverEntry?: string;
    webEntry?: string;
  };
}

function filesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function featureManifests(): Array<{ id: string; dir: string; manifest: PackageManifest }> {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = join(packagesDir, entry.name);
      const manifestPath = join(dir, "package.json");
      if (!existsSync(manifestPath)) return [];
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
      return manifest.polyth?.serverEntry
        ? [{ id: entry.name, dir, manifest }]
        : [];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

test("all browser feature packages own a canonical web entry", () => {
  const browserFeatures = featureManifests()
    .filter(({ manifest }) => manifest.polyth?.webEntry !== undefined);

  assert.ok(browserFeatures.some((pkg) => pkg.id === "editor"));
  assert.ok(browserFeatures.some((pkg) => pkg.id === "opencode"));
  assert.ok(browserFeatures.some((pkg) => pkg.id === "gitlab"));
  assert.ok(browserFeatures.some((pkg) => pkg.id === "personal-coach"));
  assert.ok(browserFeatures.some((pkg) => pkg.id === "recap"));
  for (const { id, dir, manifest } of browserFeatures) {
    assert.equal(
      manifest.polyth?.webEntry,
      "./widgets/index.tsx",
      `${id} must expose its package-owned widgets/index.tsx`,
    );
    assert.ok(
      existsSync(join(dir, "widgets/index.tsx")),
      `${id} is missing widgets/index.tsx`,
    );
  }
});

// Feature widgets may consume these generic shell services and primitives while
// the bounded web-package host is expanded. Any new app import must be reviewed:
// package-owned helpers, components, state, and API clients belong in the package.
const GENERIC_SHELL_IMPORTS = new Set([
  "alerts.ts",
  "attachments.ts",
  "chatclip.ts",
  "components/a11y/Dialog.tsx",
  "components/a11y/announce.ts",
  "components/a11y/live.tsx",
  "components/a11y/Menu.ts",
  // The canonical quick-action button under a message, for package buttons in
  // `session.message.actions` (Workflow, read aloud).
  "components/ChatActionButton.tsx",
  // The live agent status dock: the chat surface's fallback and the git
  // package's edited-files dock render the same host component.
  "components/AgentLiveStatusDock.tsx",
  // A package composer shows the files it carries the way Chat's does (an
  // agent's page): the same pill row, removable or read-only.
  "components/AttachmentPills.tsx",
  // An agent's live turn reads its steps like the chat's activity block: the
  // same line swap, the same step presentation and the same step glyph.
  "components/ActivityTicker.tsx",
  "components/ExecutionIcon.tsx",
  "execution.ts",
  "components/CopyButton.tsx",
  "components/EmptyState.tsx",
  "components/ProjectGlyph.tsx",
  "components/mobile/sheetTrigger.ts",
  "components/mobile/Sheet.tsx",
  "components/MoveControls.tsx",
  "components/Picker.tsx",
  "components/settings/parts.tsx",
  "components/ui/Button.tsx",
  "components/ui/Icon.tsx",
  "components/ui/icons.ts",
  "components/ui/index.ts",
  "components/ui/Popover.tsx",
  "components/workspace/PaneHost.tsx",
  "composer/discovery.ts",
  "composerInsert.ts",
  "desktopBridge.ts",
  "diff.ts",
  "dnd.ts",
  "format.ts",
  // Host mirror of the account's owner-set guardrails (Protected mode); any
  // feature with a refused control consults it instead of guessing.
  "guardrails.ts",
  "haptics.ts",
  "highlight.ts",
  "i18n/index.ts",
  "icons.tsx",
  "init.ts",
  "markdown/JsonTree.tsx",
  // The Markdown image viewer is a generic primitive over AttachmentPreview
  // (docs/dev/ui.md §6); chat-block galleries open the same viewer.
  "markdown/ImageLightbox.tsx",
  "markdown.tsx",
  "mobileViewport.ts",
  "pendingChanges.ts",
  // These four modules are generic host responsibilities: project presentation
  // persistence, canonical resource navigation, session activity resolution,
  // and the shared project identity primitive.
  "projectPresentationSync.ts",
  "reduce.ts",
  "resources/documents.ts",
  "resources/liveFile.ts",
  "resources/navigation.ts",
  "resources/providers.ts",
  "resources/views.ts",
  "responsiveShell.ts",
  "review/anchors.ts",
  "selectionActions.ts",
  "sessionActivity.ts",
  "settings.ts",
  "sessionStatusPopover.ts",
  "store.ts",
  "trackForm.ts",
  "uiPrefs.ts",
  "useEscape.ts",
  "utils.ts",
  "widgets/catalog.ts",
  "widgets/widgetLayout.ts",
  "workspace/mainSlotPanes.ts",
  "workspace/panePrefs.ts",
  "workspace/paneProviders.ts",
  "workspace/paneStore.ts",
  "workspace/paneVisibility.ts",
  // The shared reorder engine (lift, FLIP, auto-scroll) behind the navigators;
  // Usage → Limits reorders its providers with the same feel.
  "workspaceArrange.ts",
]);

function isWorkflowSurfaceReadImport(
  packageId: string,
  packagePath: string,
  source: string,
  shellPath: string,
): boolean {
  if (packageId !== "workflow"
    || packagePath !== "widgets/WorkflowTimelineCard.tsx"
    || shellPath !== "surfaces.ts") return false;
  const imports = [...source.matchAll(/import\s+([^;"']+?)\s+from\s+(["'])(?:\.\.\/)+apps\/web\/src\/surfaces\.ts\2\s*;?/g)];
  const references = [...source.matchAll(/["'](?:\.\.\/)+apps\/web\/src\/surfaces\.ts["']/g)];
  return imports.length === 1 && references.length === 1
    && imports[0]![1]!.replaceAll(/\s+/g, " ").trim() === "{ listSurfaces, useSurfaceVersion }";
}

test("workflow timeline gets only its narrow read-only surface access", () => {
  const packagePath = "widgets/WorkflowTimelineCard.tsx";
  const source = [
    'import { useEffect, useRef, useState } from "react";',
    'import type { WorkflowRunDto } from "@polyth/contracts";',
    'import { api } from "@polyth/session/web-api";',
    'import { listSurfaces, useSurfaceVersion } from "../../../apps/web/src/surfaces.ts";',
  ].join("\n");
  assert.equal(isWorkflowSurfaceReadImport("workflow", packagePath, source, "surfaces.ts"), true);
  assert.equal(isWorkflowSurfaceReadImport(
    "workflow",
    packagePath,
    'import { listSurfaces, registerSurface, useSurfaceVersion } from "../../../apps/web/src/surfaces.ts";',
    "surfaces.ts",
  ), false, "surface mutation must stay private to the host");
  assert.equal(isWorkflowSurfaceReadImport(
    "workflow",
    packagePath,
    'import { listSurfaces, useSurfaceVersion, hasSurfaceRegistration } from "../../../apps/web/src/surfaces.ts";',
    "surfaces.ts",
  ), false, "additional registry access needs its own ownership review");
  assert.equal(isWorkflowSurfaceReadImport(
    "workflow",
    packagePath,
    'import * as surfaces from "../../../apps/web/src/surfaces.ts";',
    "surfaces.ts",
  ), false, "namespace imports expose the whole registry");
  assert.equal(isWorkflowSurfaceReadImport(
    "workflow",
    packagePath,
    'const surfaces = await import("../../../apps/web/src/surfaces.ts");',
    "surfaces.ts",
  ), false, "dynamic imports also expose unreviewed registry access");
  assert.equal(isWorkflowSurfaceReadImport(
    "workflow", packagePath,
    source + '\nconst surfaces = await import("../../../apps/web/src/surfaces.ts");',
    "surfaces.ts",
  ), false, "a permitted read import must not mask additional registry access");
  assert.equal(isWorkflowSurfaceReadImport("git", packagePath, source, "surfaces.ts"), false);
  assert.equal(isWorkflowSurfaceReadImport("workflow", "widgets/index.tsx", source, "surfaces.ts"), false);
});

test("feature widgets import only the documented generic web shell", () => {
  const leaks: string[] = [];
  for (const { id, dir, manifest } of featureManifests()) {
    if (!manifest.polyth?.webEntry) continue;
    const widgetsDir = join(dir, "widgets");
    for (const file of filesUnder(widgetsDir)) {
      if (![".ts", ".tsx"].includes(extname(file))) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/["'](?:\.\.\/)+apps\/web\/src\/([^"']+)["']/g)) {
        const shellPath = match[1]!;
        if (!GENERIC_SHELL_IMPORTS.has(shellPath)
          && !isWorkflowSurfaceReadImport(id, relative(dir, file), source, shellPath)) {
          leaks.push(`${id}/${relative(dir, file)} -> apps/web/src/${shellPath}`);
        }
      }
    }
  }
  assert.deepEqual(
    leaks,
    [],
    "feature-owned web code must stay in its package; only generic shell imports are allowed",
  );
});

test("package homes can only register through the system window seam", () => {
  const violations: string[] = [];
  for (const { id, dir, manifest } of featureManifests()) {
    if (!manifest.polyth?.webEntry) continue;
    const entry = readFileSync(join(dir, "widgets/index.tsx"), "utf8");
    if (/workspaceSurfaces|__polyth(?:Workspace)?Surfaces/.test(entry)) violations.push(`${id}: legacy surface seam`);
  }
  assert.deepEqual(violations, [], "packages supply content and metadata; the host owns every window shell");
});

test("CodeMirror stays inside @polyth/editor and is lazy from the package entry", () => {
  const leaks: string[] = [];
  for (const { id, dir, manifest } of featureManifests()) {
    if (!manifest.polyth?.webEntry) continue;
    if (id === "editor") continue;
    const widgetsDir = join(dir, "widgets");
    if (!existsSync(widgetsDir)) continue;
    for (const file of filesUnder(widgetsDir)) {
      if (![".ts", ".tsx"].includes(extname(file))) continue;
      const source = readFileSync(file, "utf8");
      if (source.includes("@codemirror/") || source.includes("from \"codemirror\"")) {
        leaks.push(`${id}/${relative(dir, file)}`);
      }
    }
  }
  assert.deepEqual(leaks, [], "only @polyth/editor may import CodeMirror");
  const entry = readFileSync(join(packagesDir, "editor/widgets/index.tsx"), "utf8");
  assert.equal(entry.includes("@codemirror/"), false, "editor entry must not import CodeMirror");
  assert.match(entry, /lazy\(\(\) => import\("\.\/runtime\.tsx"\)\)/);
});

// These imports assemble package locale bundles and connect package-owned state
// to generic shell controls. They are integration infrastructure, not feature UI.
const GENERIC_PACKAGE_IMPORTERS = new Set([
  "components/Composer.tsx",
  "components/ComposerAddMenu.tsx",
  // The composer's pure decision module, extracted from the two components
  // above. It applies the command package's own `/name` precedence rule to the
  // shell's autocomplete; reimplementing that rule here would let the two
  // disagree. Imports the browser-safe `@polyth/commands/catalog` only.
  "composer/discovery.ts",
  "components/ContextRail.tsx",
  "components/Header.tsx",
  "components/Timeline.tsx",
  "composer/discovery.ts",
  "i18n/index.ts",
  "i18n/types.ts",
  "profiles.ts",
  "shell.ts",
]);

// Generic shell integrations that consume a package's browser-safe helper
// surface. Keep these scoped to both the importer and full export specifier;
// a new package dependency in one of these files still needs review.
const GENERIC_PACKAGE_IMPORTS = new Map<string, ReadonlySet<string>>([
  ["settingsSync.ts", new Set(["@polyth/models", "@polyth/models/web-prefs", "@polyth/models/model-visibility-prefs"])],
  ["init.ts", new Set(["@polyth/models/runtime-catalog"])],
  ["packages/registry.ts", new Set(["@polyth/models/runtime-catalog"])],
  ["composer/extensionCommandGate.ts", new Set(["@polyth/commands/catalog"])],
  // The builtin `/compact` resolver applies the command package's own `/name`
  // precedence rule, exactly like composer/discovery.ts; it imports only the
  // browser-safe catalog surface.
  ["composer/compactCommand.ts", new Set(["@polyth/commands/catalog"])],
  ["packages/sandbox/extensionCommands.tsx", new Set(["@polyth/commands/catalog"])],
  // Settings pages render the composer's shared model picker; the primitive
  // stays one implementation instead of a settings-only fork.
  ["components/settings/SessionsPage.tsx", new Set(["@polyth/models/model-picker", "@polyth/models/runtime-catalog"])],
  ["components/settings/pages.tsx", new Set(["@polyth/models/model-picker"])],
  ["components/settings/UserDetail.tsx", new Set(["@polyth/models/model-picker"])],
  // Starting a session from a conversation picks its model with that same
  // picker over the project's runtime catalog, like the composer does.
  ["components/ConversationStartDialog.tsx", new Set(["@polyth/models/model-picker", "@polyth/models/runtime-catalog"])],
  // The agent's status line and its subagents' marks tint each harness logo
  // with the profile color from the same roster the composer's model chip reads.
  ["components/AgentLiveStatusDock.tsx", new Set(["@polyth/models/runtime-catalog"])],
  ["components/SubagentActivityDock.tsx", new Set(["@polyth/models/runtime-catalog"])],
  // The island's transcript fallback shares the canonical todo normalizer
  // every harness adapter uses, so both read the same native todo shapes.
  ["mobileIsland.ts", new Set(["@polyth/todos"])],
  // Tool rows read todo calls (native and `polyth_todo`) with that same normalizer.
  ["toolCallView.ts", new Set(["@polyth/todos"])],
]);

const hasExactGenericPackageImport = (appPath: string, specifier: string): boolean =>
  GENERIC_PACKAGE_IMPORTS.get(appPath)?.has(specifier) === true;

test("generic package integration exceptions require the exact importer and export", () => {
  assert.equal(hasExactGenericPackageImport("settingsSync.ts", "@polyth/models"), true);
  assert.equal(hasExactGenericPackageImport("settingsSync.ts", "@polyth/models/web-prefs"), true);
  assert.equal(hasExactGenericPackageImport("settingsSync.ts", "@polyth/models/web-prefs/private"), false);
  assert.equal(hasExactGenericPackageImport("settingsSync.ts", "@polyth/models/runtime-catalog"), false);
  assert.equal(hasExactGenericPackageImport("settingsSync.ts", "@polyth/models-extra"), false);
  assert.equal(hasExactGenericPackageImport("init.ts", "@polyth/models/runtime-catalog"), true);
  assert.equal(hasExactGenericPackageImport("init.ts", "@polyth/models/runtime-catalog/private"), false);
  assert.equal(hasExactGenericPackageImport("packages/registry.ts", "@polyth/models/runtime-catalog"), true);
  assert.equal(hasExactGenericPackageImport("packages/registry.ts", "@polyth/models/runtime-catalog/private"), false);
  assert.equal(hasExactGenericPackageImport("composer/extensionCommandGate.ts", "@polyth/commands/catalog"), true);
  assert.equal(hasExactGenericPackageImport("composer/extensionCommandGate.ts", "@polyth/commands/catalog/private"), false);
  assert.equal(hasExactGenericPackageImport("packages/sandbox/extensionCommands.tsx", "@polyth/commands/catalog"), true);
  assert.equal(hasExactGenericPackageImport("packages/sandbox/extensionCommands.tsx", "@polyth/commands/catalog/unsafe"), false);
  assert.equal(hasExactGenericPackageImport("mobileIsland.ts", "@polyth/todos"), true);
  assert.equal(hasExactGenericPackageImport("mobileIsland.ts", "@polyth/todos/rule"), false);
  assert.equal(hasExactGenericPackageImport("toolCallView.ts", "@polyth/todos"), true);
  assert.equal(hasExactGenericPackageImport("toolCallView.ts", "@polyth/todos/rule"), false);
  assert.equal(hasExactGenericPackageImport("components/settings/SessionsPage.tsx", "@polyth/models/model-picker"), true);
  assert.equal(hasExactGenericPackageImport("components/settings/SessionsPage.tsx", "@polyth/models/runtime-catalog"), true);
  assert.equal(hasExactGenericPackageImport("components/settings/SessionsPage.tsx", "@polyth/models/runtime-catalog/private"), false);
  assert.equal(hasExactGenericPackageImport("components/settings/pages.tsx", "@polyth/models/model-picker"), true);
  assert.equal(hasExactGenericPackageImport("components/settings/pages.tsx", "@polyth/models/model-picker/private"), false);
  assert.equal(hasExactGenericPackageImport("components/settings/UserDetail.tsx", "@polyth/models/model-picker"), true);
  for (const importer of GENERIC_PACKAGE_IMPORTS.keys()) {
    assert.equal(GENERIC_PACKAGE_IMPORTERS.has(importer), false, `${importer} must not be broadly approved`);
  }
});

test("the app imports feature packages only from documented shell infrastructure", () => {
  const featureIds = new Set(featureManifests().map(({ id }) => id));
  const leaks: string[] = [];
  for (const file of filesUnder(webSrcDir)) {
    if (![".ts", ".tsx"].includes(extname(file))) continue;
    const appPath = relative(webSrcDir, file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/["'](@polyth\/[^"']+)["']/g)) {
      const specifier = match[1]!;
      const packageId = /^@polyth\/([^/]+)/.exec(specifier)?.[1];
      const genericImporter = GENERIC_PACKAGE_IMPORTERS.has(appPath)
        || appPath.startsWith("i18n/catalogs/");
      const exactGenericImport = hasExactGenericPackageImport(appPath, specifier);
      if (packageId && featureIds.has(packageId) && !genericImporter && !exactGenericImport) {
        leaks.push(`${appPath} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(
    leaks,
    [],
    "feature package imports in apps/web must be generic shell integration",
  );
});

test("feature-named source files do not return to the web app", () => {
  const featureIds = featureManifests()
    .map(({ id }) => id.replaceAll("-", "").toLowerCase());
  const genericNamedFiles = new Set([
    "commands.ts",
    "handoffTargets.ts",
    "components/input/editorCore.ts",
    "packages/onboarding/tours/git.ts",
    // A shared run-status primitive ("agent status"), not the Agents package.
    "components/ui/AgentStatusDock.tsx",
  ]);
  const leaks = filesUnder(webSrcDir)
    .map((file) => relative(webSrcDir, file))
    .filter((file) => [".ts", ".tsx"].includes(extname(file)))
    .filter((file) => !genericNamedFiles.has(file))
    .filter((file) => {
      const name = file.slice(file.lastIndexOf("/") + 1, -extname(file).length)
        .replaceAll(/[^a-z0-9]/gi, "")
        .toLowerCase();
      return featureIds.some((id) => name.startsWith(id));
    });
  assert.deepEqual(leaks, [], "feature-named app sources must live in packages/<feature>");
});
