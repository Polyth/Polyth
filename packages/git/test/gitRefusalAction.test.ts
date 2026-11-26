import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./tsxHooks.mjs", import.meta.url);
const { branchRefusalOf, gitRefusalAction, branchRefusalMessage } = await import("../widgets/gitRefusal.ts");

const failure = (code: string, refusal: Record<string, unknown>) =>
  Object.assign(new Error("x"), { code, refusal });

test("branch-in-use opens the newest chat there, else starts one in that checkout", () => {
  const calls: string[] = [];
  const context = {
    projectId: "p1",
    openSession: (id: string) => calls.push(`open:${id}`),
    startChatIn: (project: string, path: string) => calls.push(`start:${project}:${path}`),
  };
  const withChats = gitRefusalAction(failure("branch-in-use", { branch: "b", worktreePath: "/w", sessionIds: ["s2", "s1"] }), context);
  assert.ok(withChats);
  withChats.run();
  const none = gitRefusalAction(failure("branch-in-use", { branch: "b", worktreePath: "/w", sessionIds: [] }), context);
  assert.ok(none);
  none.run();
  assert.deepEqual(calls, ["open:s2", "start:p1:/w"]);
});

test("worktree-dirty with files offers Review changes; the remove-worktree dirty refusal does not", () => {
  let reviewed = 0;
  const action = gitRefusalAction(failure("worktree-dirty", { files: ["a.txt"], count: 1 }), { reviewChanges: () => { reviewed += 1; } });
  assert.ok(action);
  action.run();
  assert.equal(reviewed, 1);
  const removal = Object.assign(new Error("dirty"), { code: "worktree-dirty", changes: 3 });
  assert.equal(branchRefusalOf(removal), null);
  assert.equal(gitRefusalAction(removal, { reviewChanges: () => undefined }), null);
});

test("the refusal reads back as typed details and unknown codes stay unactioned", () => {
  const refusal = branchRefusalOf(failure("branch-in-use", { branch: "feat", worktreeLabel: "wt", sessionIds: ["s"] }));
  assert.equal(refusal?.code, "branch-in-use");
  assert.ok(refusal && branchRefusalMessage(refusal).length > 0);
  assert.equal(gitRefusalAction(failure("git-failed", {}), {}), null);
});
