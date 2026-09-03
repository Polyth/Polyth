import test from "node:test";
import assert from "node:assert/strict";
import type { SshConnectionDto } from "@polyth/contracts";
import {
  connectionTarget,
  emptySshForm,
  formFromConnection,
  formToInput,
  remoteBasename,
  runtimeNeedsInstall,
  stateBadge,
  validateSshForm,
} from "../widgets/ssh/sshUi.ts";
import { tr } from "../../../apps/web/src/i18n/index.ts";

const conn = (over: Partial<SshConnectionDto> = {}): SshConnectionDto => ({
  id: "c1",
  name: "Build box",
  host: "build.example.com",
  user: "dev",
  port: 2222,
  authMode: "agent",
  createdAt: 1,
  ...over,
});

test("formFromConnection round-trips through formToInput", () => {
  const values = formFromConnection(conn({ authMode: "identity-file", identityFile: "~/.ssh/id_ed25519" }));
  assert.equal(values.port, "2222");
  assert.equal(values.authMode, "identity-file");
  const input = formToInput(values);
  assert.deepEqual(input, {
    host: "build.example.com",
    name: "Build box",
    user: "dev",
    authMode: "identity-file",
    identityFile: "~/.ssh/id_ed25519",
    port: 2222,
  });
});

test("formToInput omits port when blank and drops the key path for agent auth", () => {
  const input = formToInput({ ...emptySshForm, host: " host ", identityFile: "/ignored" });
  assert.equal(input.host, "host");
  assert.equal(input.identityFile, "");
  assert.equal("port" in input, false);
});

test("validateSshForm mirrors server-side checks", () => {
  assert.equal(validateSshForm({ ...emptySshForm, host: "ok.example" }), null);
  assert.match(validateSshForm(emptySshForm) ?? "", /Host is required/);
  assert.match(validateSshForm({ ...emptySshForm, host: "-oProxyCommand=x" }) ?? "", /dash/);
  assert.match(validateSshForm({ ...emptySshForm, host: "two words" }) ?? "", /spaces/);
  assert.match(validateSshForm({ ...emptySshForm, host: "h", user: "a b" }) ?? "", /login name/);
  assert.match(validateSshForm({ ...emptySshForm, host: "h", user: "x@y" }) ?? "", /login name/);
  assert.match(validateSshForm({ ...emptySshForm, host: "h", port: "0" }) ?? "", /between 1 and 65535/);
  assert.match(validateSshForm({ ...emptySshForm, host: "h", port: "70000" }) ?? "", /between 1 and 65535/);
  assert.match(validateSshForm({ ...emptySshForm, host: "h", port: "abc" }) ?? "", /between 1 and 65535/);
  assert.match(
    validateSshForm({ ...emptySshForm, host: "h", authMode: "identity-file" }) ?? "",
    /private-key file/,
  );
  assert.equal(
    validateSshForm({ ...emptySshForm, host: "h", authMode: "identity-file", identityFile: "~/.ssh/key" }),
    null,
  );
});

test("connectionTarget renders user@host and hides the default port", () => {
  assert.equal(connectionTarget(conn()), "dev@build.example.com:2222");
  assert.equal(connectionTarget(conn({ port: 22 })), "dev@build.example.com");
  assert.equal(connectionTarget({ host: "alias" }), "alias");
});

test("stateBadge maps connection states to text and tone", () => {
  assert.deepEqual(stateBadge("connected"), { text: tr("ssh.sshui.connected"), tone: "ok" });
  assert.deepEqual(stateBadge("auth-failed"), { text: tr("ssh.sshui.authFailed"), tone: "err" });
  assert.deepEqual(stateBadge("unreachable"), { text: tr("ssh.sshui.unreachable"), tone: "err" });
  assert.deepEqual(stateBadge("disconnected"), { text: tr("ssh.sshui.disconnected"), tone: "muted" });
  assert.deepEqual(stateBadge(undefined), { text: tr("ssh.sshui.unknown"), tone: "muted" });
});

test("runtimeNeedsInstall only enables the installer for a missing runtime", () => {
  assert.equal(runtimeNeedsInstall({ ok: false, installable: true }), true);
  assert.equal(runtimeNeedsInstall({ ok: false }), false);
  assert.equal(runtimeNeedsInstall({ ok: true, installable: true }), false);
});

test("remoteBasename suggests a project name from a POSIX path", () => {
  assert.equal(remoteBasename("/srv/apps/polyth"), "polyth");
  assert.equal(remoteBasename("/srv/apps/polyth///"), "polyth");
  assert.equal(remoteBasename("/"), "");
  assert.equal(remoteBasename(""), "");
});
