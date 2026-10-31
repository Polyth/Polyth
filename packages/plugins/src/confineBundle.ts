import { realpath } from "node:fs/promises";
import { dirname, sep } from "node:path";
import type { Plugin } from "esbuild";

const inside = (base: string, candidate: string): boolean =>
  candidate === base || candidate.startsWith(base + sep);

export function confineBundlePlugin(opts: {
  installDir: string;
  allowedRoots: readonly string[];
}): Plugin {
  const roots = opts.allowedRoots;
  return {
    name: "polyth-confine-package",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.polythConfined) return undefined;
        const resolved = await build.resolve(args.path, {
          importer: args.importer,
          kind: args.kind,
          resolveDir: args.resolveDir || (args.importer ? dirname(args.importer) : opts.installDir),
          namespace: args.namespace,
          pluginData: { polythConfined: true },
        });
        if (resolved.errors.length > 0) return resolved;
        if (!resolved.path) {
          return { errors: [{ text: `could not resolve ${args.path}` }] };
        }
        if (resolved.external) return resolved;
        let real: string;
        try {
          real = await realpath(resolved.path);
        } catch {
          return { errors: [{ text: `import is not a readable file: ${args.path}` }] };
        }
        if (!roots.some((root) => inside(root, real))) {
          return { errors: [{ text: `import escapes the package: ${args.path}` }] };
        }
        return { ...resolved, path: real };
      });
    },
  };
}
