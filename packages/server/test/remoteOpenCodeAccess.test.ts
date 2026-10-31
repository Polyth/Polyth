// The remote OpenCode runtime asks the SSH transport whose use a launch is,
// as resolveRemoteHarnessHost does for every other remote harness (§14.6).
import test from "node:test";
import assert from "node:assert/strict";
import { assertRemoteOpenCodeUsable, type RemoteOpenCodeAccessDeps } from "../src/remoteOpenCodeAccess.ts";

type Principal = Parameters<NonNullable<RemoteOpenCodeAccessDeps["usable"]>>[1];

function deps(actors: Record<string, string>, members: Record<string, { instanceOwner?: boolean }>) {
  const asked: Principal[] = [];
  const access: RemoteOpenCodeAccessDeps = {
    // A personal connection of usr_owner: usable by them, or on a binding.
    usable: (connectionId, principal) => {
      asked.push(principal);
      if (connectionId !== "u.usr_owner.c1") return false;
      return principal.kind === "binding" || principal.userId === "usr_owner";
    },
    actorOf: async (sessionId) => actors[sessionId],
    personSpaceContext: (userId) => members[userId],
  };
  return { access, asked };
}

test("a session's acting person must be able to use the connection", async () => {
  const { access, asked } = deps(
    { mine: "usr_owner", theirs: "usr_member", departed: "usr_gone" },
    { usr_owner: {}, usr_member: {} },
  );
  const input = (sessionId?: string) => ({ connectionId: "u.usr_owner.c1", spaceId: "spc_home", ...(sessionId ? { sessionId } : {}) });

  await assertRemoteOpenCodeUsable(access, input("mine"));
  assert.deepEqual(asked.at(-1), { kind: "person", userId: "usr_owner", spaceId: "spc_home", instanceOwner: false });

  await assert.rejects(assertRemoteOpenCodeUsable(access, input("theirs")), { code: "not-found", message: "unknown SSH connection" });
  assert.deepEqual(asked.at(-1), { kind: "person", userId: "usr_member", spaceId: "spc_home", instanceOwner: false });

  // No person (a probe, a turn nobody started, an actor who left): the binding decides.
  await assertRemoteOpenCodeUsable(access, input());
  assert.deepEqual(asked.at(-1), { kind: "binding", spaceId: "spc_home" });
  await assertRemoteOpenCodeUsable(access, input("departed"));
  assert.deepEqual(asked.at(-1), { kind: "binding", spaceId: "spc_home" });
  await assertRemoteOpenCodeUsable(access, input("unknown-session"));
  assert.deepEqual(asked.at(-1), { kind: "binding", spaceId: "spc_home" });

  await assert.rejects(assertRemoteOpenCodeUsable(access, { connectionId: "other", spaceId: "spc_home" }), { code: "not-found" });
});

test("the instance owner flag reaches the transport, and older transports are not asked", async () => {
  const { access, asked } = deps({ s: "usr_root" }, { usr_root: { instanceOwner: true } });
  await assert.rejects(assertRemoteOpenCodeUsable(access, { connectionId: "x", spaceId: "spc_home", sessionId: "s" }));
  assert.deepEqual(asked.at(-1), { kind: "person", userId: "usr_root", spaceId: "spc_home", instanceOwner: true });

  const { usable: _usable, ...legacy } = access;
  await assertRemoteOpenCodeUsable(legacy, { connectionId: "x", spaceId: "spc_home", sessionId: "s" });
});
