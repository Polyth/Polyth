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

  assert.equal(browserFeatures.length, 30);
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
  "components/CopyButton.tsx",
  "components/EmptyState.tsx",
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
  "haptics.ts",
  "highlight.ts",
  "i18n/index.ts",
  "icons.tsx",
  "init.ts",
  "markdown/JsonTree.tsx",
  "markdown.tsx",
  "mobileViewport.ts",
  "pendingChanges.ts",
  "reduce.ts",
  "responsiveShell.ts",
  "review/anchors.ts",
  "selectionActions.ts",
  "settings.ts",
  "store.ts",
  "trackForm.ts",
  "uiPrefs.ts",
  "useEscape.ts",
  "usePopoverPlacement.ts",
  "utils.ts",
  "widgets/catalog.ts",
  "widgets/widgetLayout.ts",
  "workspace/mainSlotPanes.ts",
  "workspace/panePrefs.ts",
  "workspace/paneProviders.ts",
  "workspace/paneStore.ts",
  "workspace/paneVisibility.ts",
]);

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
        if (!GENERIC_SHELL_IMPORTS.has(shellPath)) {
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

// These imports assemble package locale bundles and connect package-owned state
// to generic shell controls. They are integration infrastructure, not feature UI.
const GENERIC_PACKAGE_IMPORTERS = new Set([
  "components/AgentProfileForm.tsx",
  "components/Composer.tsx",
  "components/ComposerAddMenu.tsx",
  "components/EffortMenu.tsx",
  "components/ContextRail.tsx",
  "components/Header.tsx",
  "components/Timeline.tsx",
  "i18n/index.ts",
  "i18n/types.ts",
  "profiles.ts",
  "shell.ts",
]);

test("the app imports feature packages only from documented shell infrastructure", () => {
  const featureIds = new Set(featureManifests().map(({ id }) => id));
  const leaks: string[] = [];
  for (const file of filesUnder(webSrcDir)) {
    if (![".ts", ".tsx"].includes(extname(file))) continue;
    const appPath = relative(webSrcDir, file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/["']@polyth\/([^/"']+)/g)) {
      const genericImporter = GENERIC_PACKAGE_IMPORTERS.has(appPath)
        || appPath.startsWith("i18n/catalogs/");
      if (featureIds.has(match[1]!) && !genericImporter) {
        leaks.push(`${appPath} -> @polyth/${match[1]}`);
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
    "packages/onboarding/tours/git.ts",
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
