// "Only me": a private room is on the shell's registry so its chats find their
// project, and is never a project anyone picks. Nothing about other people shows
// until someone else really works in the project.
import assert from "node:assert/strict";
import { test } from "node:test";
import { rootProjects, type Project, type SessionSharingView } from "@polyth/contracts";
import { offersPrivateRoom, othersRead, privateRoomOf, rootProjectId, roomChatCount, roomWaiting } from "../src/privateRoom.ts";

const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, path: `/${id}`, createdAt: 0, ...extra });
const wellness = project("wellness", { sharedWith: 2, othersHere: true });
const room = project("room", { parentProjectId: "wellness", name: "wellness" });
const solo = project("solo");
const reachable = project("reachable", { sharedWith: 2 });

test("pickers list projects, never rooms, and a stable input gives a stable list", () => {
  const all = [wellness, solo, room];
  assert.deepEqual(rootProjects(all).map((row) => row.id), ["wellness", "solo"]);
  assert.equal(rootProjects(all), rootProjects(all), "safe in a store selector");
  const noRooms = [wellness, solo];
  assert.equal(rootProjects(noRooms), noRooms);
});

test("a private chat is offered only once someone else really works in the project", () => {
  assert.equal(offersPrivateRoom(wellness), true);
  assert.equal(offersPrivateRoom(solo), false, "someone working alone sees nothing new");
  assert.equal(offersPrivateRoom(reachable), false, "others being able to open it isn't enough");
  assert.equal(offersPrivateRoom(project("mine", { personal: true, othersHere: true })), false);
  assert.equal(offersPrivateRoom(room), false, "a room has no room");
});

test("a room resolves to its project for anything about the project", () => {
  const all = [wellness, solo, room];
  assert.equal(rootProjectId(all, "room"), "wellness");
  assert.equal(rootProjectId(all, "solo"), "solo");
  assert.equal(rootProjectId(all, null), null);
  assert.equal(privateRoomOf(all, "wellness")?.id, "room");
  assert.equal(privateRoomOf(all, "solo"), undefined);
});

test("the room's row counts its own chats, not their subagents or the archive", () => {
  const row = (projectId: string, status = "idle", parentId?: string) => ({ projectId, status, parentId }) as never;
  assert.equal(roomChatCount([row("room"), row("room"), row("wellness")], "room"), 2);
  assert.equal(roomChatCount([row("room"), row("room", "working", "parent")], "room"), 1);
  assert.equal(roomChatCount([row("room", "archived")], "room"), 0);
  assert.equal(roomChatCount([row("room")], undefined), 0, "no room yet");
});

test("the room's row says when a chat behind it is waiting", () => {
  const row = (projectId: string, attention: { questions: number; permissions: number; unread: number }, status = "idle") =>
    ({ projectId, status, attention }) as never;
  const quiet = row("room", { questions: 0, permissions: 0, unread: 0 });
  assert.equal(roomWaiting([quiet], "room"), false);
  assert.equal(roomWaiting([row("room", { questions: 1, permissions: 0, unread: 0 })], "room"), true);
  assert.equal(roomWaiting([row("room", { questions: 0, permissions: 2, unread: 0 })], "room"), true);
  assert.equal(roomWaiting([row("room", { questions: 0, permissions: 0, unread: 3 })], "room"), true);
  assert.equal(roomWaiting([row("wellness", { questions: 1, permissions: 0, unread: 0 })], "room"), false, "another project's chat");
  assert.equal(roomWaiting([row("room", { questions: 1, permissions: 0, unread: 0 }, "archived")], "room"), false);
  assert.equal(roomWaiting([row("room", { questions: 1, permissions: 0, unread: 0 })], undefined), false, "no room opened yet");
});

test("who reads a chat is said only when someone else is around to read it", () => {
  const view = (extra: Partial<SessionSharingView>): SessionSharingView => ({ visibility: "space", access: "manage", shared: true, multiPerson: true, ...extra });
  assert.equal(othersRead(undefined, wellness), false);
  assert.equal(othersRead(view({ visibility: "private", shared: false }), wellness), false, "a private chat says nothing");
  assert.equal(othersRead(view({}), reachable), false, "open to the Space, nobody else in the project");
  assert.equal(othersRead(view({}), solo), false);
  assert.equal(othersRead(view({}), wellness), true, "open to the Space, someone else in the project");
  assert.equal(othersRead(view({ named: true }), reachable), true, "given to someone by name");
  assert.equal(othersRead(view({ visibility: "restricted" }), reachable), true);
  assert.equal(othersRead(view({ owner: { userId: "usr_other" } }), reachable), true, "someone else's chat");
  assert.equal(othersRead(view({}), undefined), true, "an unknown project errs on saying so");
});
