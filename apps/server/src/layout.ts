// The packaged Polyth server's file layout, shared by its build (build.ts) and
// its entries (main.ts, cli.ts). One tree serves the release tarball and,
// later, the npm package:
//
//   polyth/
//     package.json            name "polyth", bin "polyth"
//     BUILD.json              version, commit, target
//     bin/polyth.mjs          the `polyth` command
//     dist/server.mjs         the server, every server package compiled in
//     dist/cli.mjs            the CLI (packages/cli)
//     dist/setup-claim.mjs    first-run setup claim
//     dist/break-glass.mjs    owner password reset
//     dist/agentToolsMcp.mjs  agent tools MCP bridge (a child process script)
//     resources/              POLYTH_RESOURCES_DIR, the same layout as Desktop's:
//       web/                  apps/web/dist
//       packages/<id>/        each package's dist/web and assets
//       polyth-link/          polyth-link-host
//       runtime-supervisor/   linux-<arch>/polyth-supervisor, win32/polyth-job.exe
//       THIRD_PARTY_NOTICES.txt
//     node_modules/           RUNTIME_EXTERNALS and their dependencies
import { join } from "node:path";

/** Loaded at run time, never bundled: native addons (node-pty), packages with
 *  their own module maps (playwright-core) or binaries (esbuild), and the
 *  editor's language service (typescript). The same set Desktop keeps outside
 *  its main bundle. */
export const RUNTIME_EXTERNALS = ["esbuild", "node-pty", "playwright-core", "typescript"] as const;

/** The npm package and the command it installs. */
export const PACKAGE_NAME = "polyth";

/** Release targets have the shape `<platform>-<arch>`, as Node names them. */
export function bundleTarget(platform: NodeJS.Platform, arch: string): string {
  if (!["linux", "darwin", "win32"].includes(platform)) throw new Error(`unsupported server bundle platform: ${platform}`);
  if (!["x64", "arm64"].includes(arch)) throw new Error(`unsupported server bundle architecture: ${arch}`);
  return `${platform}-${arch}`;
}

export function releaseName(version: string, target: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`invalid server bundle version: ${version}`);
  return `polyth-server-${version}-${target}`;
}

export interface BundleLayout {
  root: string;
  dist: string;
  resources: string;
  webDist: string;
  webPackages: string;
}

/** Paths inside an installed bundle, from its root directory. */
export function bundleLayout(root: string): BundleLayout {
  const resources = join(root, "resources");
  return {
    root,
    dist: join(root, "dist"),
    resources,
    webDist: join(resources, "web"),
    webPackages: join(resources, "packages"),
  };
}

export interface StagePackageInput {
  version: string;
  /** Exact versions of the runtime externals the build copied. */
  dependencies: Record<string, string>;
  nodeEngine: string;
}

/** package.json at the bundle root. */
export function stagePackageJson({ version, dependencies, nodeEngine }: StagePackageInput) {
  return {
    name: PACKAGE_NAME,
    version,
    description: "Polyth server: run and supervise coding agents from any device",
    license: "Apache-2.0",
    homepage: "https://polyth.app",
    repository: { type: "git", url: "git+https://github.com/Polyth/Polyth.git" },
    type: "module",
    bin: { [PACKAGE_NAME]: "bin/polyth.mjs" },
    engines: { node: nodeEngine },
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
  };
}

// ---- npm ------------------------------------------------------------------
//
// npm gets the same tree split in two. `polyth` carries the code (bin/, dist/)
// and is the same everywhere; `@polyth/server-<target>` carries `resources/`
// for one platform (os/cpu), and npm installs only the matching one. The
// server finds its resources beside itself (archive) or in that package (npm).

/** Platforms the server is published for. */
export const SERVER_TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;

export function platformPackageName(target: string): string {
  return `@polyth/server-${target}`;
}

const publishedFields = {
  license: "Apache-2.0",
  homepage: "https://polyth.app",
  repository: { type: "git", url: "git+https://github.com/Polyth/Polyth.git" },
} as const;

/** package.json of the `polyth` npm package. */
export function npmMainPackageJson({ version, dependencies, optionalDependencies, nodeEngine }: {
  version: string;
  dependencies: Record<string, string>;
  /** node-pty: npm builds it where it can; without it terminals run without a PTY. */
  optionalDependencies: Record<string, string>;
  nodeEngine: string;
}) {
  const sorted = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  return {
    name: PACKAGE_NAME,
    version,
    description: "Polyth server: run and supervise coding agents from any device",
    ...publishedFields,
    type: "module",
    bin: { [PACKAGE_NAME]: "bin/polyth.mjs" },
    engines: { node: nodeEngine },
    dependencies: sorted(dependencies),
    optionalDependencies: sorted({
      ...optionalDependencies,
      ...Object.fromEntries(SERVER_TARGETS.map((target) => [platformPackageName(target), version])),
    }),
  };
}

/** package.json of `@polyth/server-<target>`. */
export function platformPackageJson(target: string, version: string) {
  const [os, cpu] = target.split("-") as [string, string];
  return {
    name: platformPackageName(target),
    version,
    description: `Polyth server resources for ${target}: web app, package assets and native helpers`,
    ...publishedFields,
    os: [os],
    cpu: [cpu],
    preferUnplugged: true,
  };
}

export const NPM_README = `# polyth

The Polyth server: run and supervise coding agents (Claude Code, Codex, OpenCode,
Gemini and more) from a browser, the desktop app or your phone.

\`\`\`bash
npm install --global polyth
polyth server setup-claim   # first run only, with the server stopped
polyth server start
\`\`\`

Node.js 22.16 or newer. npm installs the one \`@polyth/server-<platform>-<arch>\`
package for this machine. Documentation: https://github.com/Polyth/Polyth/blob/master/docs/operations/running.md#packaged-server
`;

/** The `polyth` command: hands over to the bundled CLI. */
export const LAUNCHER = `#!/usr/bin/env node
// The \`polyth\` command of a packaged Polyth server.
import "../dist/cli.mjs";
`;
