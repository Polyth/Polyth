// "Shared / Only me": a private room is on the shell's registry so its chats find
// their project, and is never a project anyone picks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { rootProjects, type Project } from "@polyth/contracts";
import { inPrivateLane, laneWaiting, offersPrivateRoom, privateRoomOf, rootProjectId } from "../src/privateRoom.ts";

const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, path: `/${id}`, createdAt: 0, ...extra });
const wellness = project("wellness", { sharedWith: 2 });
const room = project("room", { parentProjectId: "wellness", name: "wellness" });
const solo = project("solo");

test("pickers list projects, never rooms, and a stable input gives a stable list", () => {
  const all = [wellness, solo, room];
  assert.deepEqual(rootProjects(all).map((row) => row.id), ["wellness", "solo"]);
  assert.equal(rootProjects(all), rootProjects(all), "safe in a store selector");
  const noRooms = [wellness, solo];
  assert.equal(rootProjects(noRooms), noRooms);
});

test("the switch appears only once a project has someone to be private from", () => {
  assert.equal(offersPrivateRoom(wellness), true);
  assert.equal(offersPrivateRoom(solo), false, "someone working alone sees nothing new");
  assert.equal(offersPrivateRoom(project("mine", { personal: true, sharedWith: 3 })), false);
  assert.equal(offersPrivateRoom(room), false, "a room has no room");
});

test("a room resolves to its project for anything about the project", () => {
  const all = [wellness, solo, room];
  assert.equal(rootProjectId(all, "room"), "wellness");
  assert.equal(rootProjectId(all, "solo"), "solo");
  assert.equal(rootProjectId(all, null), null);
  assert.equal(privateRoomOf(all, "wellness")?.id, "room");
  assert.equal(privateRoomOf(all, "solo"), undefined);
  assert.equal(inPrivateLane(wellness, room), true);
  assert.equal(inPrivateLane(wellness, wellness), false);
  assert.equal(inPrivateLane(solo, room), false);
});

test("the switch says when the hidden lane has a chat waiting", () => {
  const row = (projectId: string, attention: { questions: number; permissions: number; unread: number }, status = "idle") =>
    ({ projectId, status, attention }) as never;
  const quiet = row("room", { questions: 0, permissions: 0, unread: 0 });
  assert.equal(laneWaiting([quiet], "room"), false);
  assert.equal(laneWaiting([row("room", { questions: 1, permissions: 0, unread: 0 })], "room"), true);
  assert.equal(laneWaiting([row("room", { questions: 0, permissions: 2, unread: 0 })], "room"), true);
  assert.equal(laneWaiting([row("room", { questions: 0, permissions: 0, unread: 3 })], "room"), true);
  assert.equal(laneWaiting([row("wellness", { questions: 1, permissions: 0, unread: 0 })], "room"), false, "another lane's chat");
  assert.equal(laneWaiting([row("room", { questions: 1, permissions: 0, unread: 0 }, "archived")], "room"), false);
  assert.equal(laneWaiting([row("room", { questions: 1, permissions: 0, unread: 0 })], undefined), false, "no room opened yet");
});
