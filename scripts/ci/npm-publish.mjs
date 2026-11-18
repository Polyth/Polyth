// Publishing a set of npm tarballs from a release job, shared by the server
// (publish-server-npm.mjs, nightly.yml) and the SDK (publish-sdk-npm.mjs,
// release.yml).
//
// Authentication: npm trusted publishing (OIDC) when the job may mint an
// id-token (`permissions: id-token: write`), which needs npm >= 11.5.1 and a
// trusted publisher for that workflow on every package; otherwise
// NODE_AUTH_TOKEN. Trusted publishing cannot create a package, so while any
// package of the set is not on npm yet nothing is published
// (docs/operations/releases.md#npm-trusted-publishing). Packages go out in
// the given order and versions already on npm are skipped, so a rerun is safe.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelOfVersion } from "./update-feed.mjs";

/** The npm dist-tag of a release channel: stable installs by default. */
export function npmDistTag(version) {
  const channel = channelOfVersion(version);
  return channel === "stable" ? "latest" : channel;
}

/** setup-node's stand-in when no token is given. */
const SETUP_NODE_PLACEHOLDER = "XXXXX-XXXXX-XXXXX-XXXXX";

/** How this job authenticates to npm: "oidc", "token" or null. */
export function npmAuthMode(env = process.env) {
  if (env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) return "oidc";
  const token = env.NODE_AUTH_TOKEN?.trim();
  return token && token !== SETUP_NODE_PLACEHOLDER ? "token" : null;
}

/** Trusted publishing needs npm 11.5.1 or newer. */
export function npmSupportsOidc(version) {
  const [major = 0, minor = 0, patch = 0] = String(version).trim().split(/[.-]/).map(Number);
  return major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)));
}

function npm(args, env = process.env) {
  return spawnSync("npm", args, { encoding: "utf8", shell: process.platform === "win32", env });
}

let anonymousEnv;
/** Registry reads without credentials: a public package needs none, and
 *  setup-node's stand-in token must not turn a read into a 401. */
function npmView(args) {
  if (!anonymousEnv) {
    const config = join(mkdtempSync(join(tmpdir(), "npm-anonymous-")), ".npmrc");
    writeFileSync(config, "registry=https://registry.npmjs.org/\n");
    anonymousEnv = { ...process.env, NPM_CONFIG_USERCONFIG: config, NODE_AUTH_TOKEN: "" };
  }
  return npm(["view", ...args], anonymousEnv);
}

/**
 * Publishes `packages` ([{ name, file }], in order) at `version` under `tag`.
 * A set that cannot be published (no credentials, an npm without trusted
 * publishing, a package not on npm yet) is a warning that publishes nothing,
 * or with `required` (someone asked for this publication) an error.
 * Returns the process exit code.
 */
export function publishNpmSet({ label, packages, version, tag, required = false }) {
  const stop = (message) => {
    console.log(`::${required ? "error" : "warning"}::${label}: ${message}`);
    return required ? 1 : 0;
  };
  const auth = npmAuthMode();
  if (!auth) return stop("no id-token permission and no NODE_AUTH_TOKEN; nothing is published to npm");
  const npmVersion = npm(["--version"]).stdout.trim();
  if (auth === "oidc" && !npmSupportsOidc(npmVersion)) {
    return stop(`npm ${npmVersion} cannot use trusted publishing (needs 11.5.1 or newer); nothing is published to npm`);
  }
  if (auth === "oidc") {
    const absent = packages.filter(({ name }) => npmView([name, "name"]).status !== 0).map(({ name }) => name);
    if (absent.length > 0) {
      return stop(`${absent.join(", ")} not on npm yet; trusted publishing cannot create a package, so publish it once by hand and add its trusted publisher (docs/operations/releases.md#npm-trusted-publishing); nothing is published to npm`);
    }
  }
  for (const { name, file } of packages) {
    if (npmView([`${name}@${version}`, "version"]).status === 0) {
      console.log(`${label}: ${name}@${version} is already published`);
      continue;
    }
    const published = npm(["publish", file, "--access", "public", "--provenance", "--tag", tag]);
    process.stdout.write(published.stdout);
    if (published.status !== 0) {
      process.stderr.write(published.stderr);
      console.error(`${label}: ${name}@${version} failed`);
      return 1;
    }
    console.log(`${label}: ${name}@${version} published (${tag}, ${auth === "oidc" ? "trusted publishing" : "token"})`);
  }
  return 0;
}
