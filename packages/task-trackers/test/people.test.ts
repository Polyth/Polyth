import test from "node:test";
import assert from "node:assert/strict";
import type { TaskTrackerTaskDto } from "@polyth/contracts";
import {
  assigneeSummary,
  avatarTone,
  boardPeople,
  emptyAssigneeTitle,
  matchesAssignees,
  ME,
  normalizeAssignees,
  ownViewer,
  personKey,
  taskPeople,
  UNASSIGNED,
} from "../widgets/people.ts";
import { normalizeBoardMemory } from "../widgets/scope.ts";

const status = { id: "todo", name: "To do", category: "todo" as const };

const task = (id: string, people: Array<[string, string]> = [], namesOnly = false): TaskTrackerTaskDto => ({
  provider: "linear",
  id,
  key: `ENG-${id}`,
  title: `Task ${id}`,
  description: "",
  status,
  labels: [],
  assignees: people.map(([, name]) => name),
  ...(namesOnly || people.length === 0 ? {} : { assigneePeople: people.map(([personId, name]) => ({ id: personId, name })) }),
});

const iris = { id: "u-iris", name: "Iris Novak" };

test("people are keyed by tracker id, by name only when the tracker gave no id", () => {
  assert.equal(personKey({ id: "u-iris", name: "Iris Novak" }), "id:u-iris");
  assert.equal(personKey({ id: "", name: "  Iris NOVAK " }), "name:iris novak");
  assert.deepEqual(taskPeople(task("1", [["u-iris", "Iris Novak"]])), [iris]);
  assert.deepEqual(taskPeople(task("2", [["", "Ada"]], true)), [{ id: "", name: "Ada" }], "older servers send names only");
  assert.equal(avatarTone("id:u-iris"), avatarTone("id:u-iris"), "a person keeps their tint");
});

test("an assignee filter matches mine, unassigned and teammates, any of them", () => {
  const mine = task("1", [["u-iris", "Iris Novak"]]);
  const leo = task("2", [["u-leo", "Leo Park"]]);
  const nobody = task("3");
  const pair = task("4", [["u-leo", "Leo Park"], ["u-iris", "Iris Novak"]]);
  const legacy = task("5", [["", "Iris Novak"]], true);
  const all = [mine, leo, nobody, pair, legacy];
  const shown = (tokens: string[], me = iris) =>
    all.filter((item) => matchesAssignees(item, new Set(tokens), me)).map((item) => item.id);

  assert.deepEqual(shown([]), ["1", "2", "3", "4", "5"]);
  assert.deepEqual(shown([ME]), ["1", "4", "5"], "a name-only task is mine by name");
  assert.deepEqual(shown([UNASSIGNED]), ["3"]);
  assert.deepEqual(shown(["id:u-leo"]), ["2", "4"]);
  assert.deepEqual(shown(["id:u-leo", UNASSIGNED]), ["2", "3", "4"]);
  assert.deepEqual(all.filter((item) => matchesAssignees(item, new Set([ME]), null)).map((item) => item.id), [],
    "nobody is mine until the board knows who I am");
});

test("board people put me first, then whoever holds most, and count the unassigned", () => {
  const tasks = [
    task("1", [["u-leo", "Leo Park"]]),
    task("2", [["u-mia", "Mia Santos"]]),
    task("3", [["u-leo", "Leo Park"], ["u-leo", "Leo Park"]]),
    task("4"),
    task("5", [["u-ada", "Ada"]]),
  ];
  const { people, unassigned } = boardPeople(tasks, iris);
  assert.deepEqual(people.map((option) => [option.person.name, option.count, option.me]), [
    ["Iris Novak", 0, true],
    ["Leo Park", 2, false],
    ["Ada", 1, false],
    ["Mia Santos", 1, false],
  ], "listed twice on one task still counts once");
  assert.equal(unassigned, 1);

  const withAvatar = boardPeople([task("1", [["u-leo", "Leo Park"]]), {
    ...task("2"),
    assignees: ["Leo Park"],
    assigneePeople: [{ id: "u-leo", name: "Leo Park", avatarUrl: "https://a.test/leo.png" }],
  }], null);
  assert.equal(withAvatar.people[0]?.person.avatarUrl, "https://a.test/leo.png", "a later task fills in a missing face");
});

test("choosing yourself in the full list reads as Mine; summaries name the filter", () => {
  assert.deepEqual([...normalizeAssignees(["id:u-iris", "id:u-leo", "", 7 as unknown as string], iris)], [ME, "id:u-leo"]);
  assert.deepEqual([...normalizeAssignees(["id:u-iris"], null)], ["id:u-iris"], "someone else's shared account stays a person");
  assert.equal(ownViewer({ person: iris, own: false }), null);
  assert.deepEqual(ownViewer({ person: iris, own: true }), iris);

  const { people } = boardPeople([task("1", [["u-leo", "Leo Park"]])], iris);
  assert.equal(assigneeSummary(new Set(), people), "Everyone");
  assert.equal(assigneeSummary(new Set([ME]), people), "Mine");
  assert.equal(assigneeSummary(new Set([UNASSIGNED]), people), "Unassigned");
  assert.equal(assigneeSummary(new Set(["id:u-leo"]), people), "Leo Park");
  assert.equal(assigneeSummary(new Set([ME, "id:u-leo"]), people), "2 people");
  assert.equal(emptyAssigneeTitle(new Set([ME]), people), "Nothing here is assigned to you");
  assert.equal(emptyAssigneeTitle(new Set([UNASSIGNED]), people), "Every task here has an assignee");
  assert.equal(emptyAssigneeTitle(new Set(["id:u-leo"]), people), "Leo Park has no tasks here");
});

test("the device remembers an assignee filter per tracker and drops what it can't read", () => {
  assert.deepEqual(normalizeBoardMemory({
    provider: "linear",
    selections: { linear: { projectId: "team-1", boardId: "team-1:proj-1" } },
    assignees: { linear: [ME, "id:u-leo", ME, 5, "x".repeat(400)], jira: [], asana: [ME] },
  }), {
    provider: "linear",
    selections: { linear: { projectId: "team-1", boardId: "team-1:proj-1" } },
    assignees: { linear: [ME, "id:u-leo"] },
  });
  assert.deepEqual(normalizeBoardMemory({ selections: {} }), { selections: {} });
});
