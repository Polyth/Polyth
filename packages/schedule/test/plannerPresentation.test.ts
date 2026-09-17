import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string) =>
  readFile(new URL(relative, import.meta.url), "utf8");

test("mobile task rows keep switch and menu on the same grid row", async () => {
  const css = await read("../widgets/styles.css");
  const row = await read("../widgets/PlannerTaskRow.tsx");
  assert.match(css, /grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/);
  assert.match(row, /className="planner-task-time"/);
  assert.match(row, /className="planner-task-main"/);
  assert.match(row, /className="planner-task-tools"/);
  assert.match(css, /\.planner-task-tools \{[\s\S]*flex-wrap:\s*nowrap;/);
  assert.doesNotMatch(
    css,
    /\.planner-task-tools \{[^}]*width:\s*100%/,
    "task tools must not stretch onto a second row",
  );
  assert.doesNotMatch(css, /\.planner-task \{[^}]*flex-wrap:\s*wrap/);
  assert.match(
    row,
    /className=\{`planner-task[\s\S]*<span className="planner-task-time">[\s\S]*className="planner-task-main"[\s\S]*className="planner-task-tools"/,
  );
});

test("project picker is an anchored compact picker on phone", async () => {
  const source = await read("../widgets/PlannerProjectPicker.tsx");
  assert.match(source, /useShellMode\(\) === "phone"/);
  assert.match(source, /anchorRef: RefObject<HTMLElement \| null>/);
  assert.match(source, /phone="popover"/);
  assert.match(source, /stableAnchor/);
  assert.match(source, /initialFocus=\{!phone && searchable/);
  assert.match(source, /searchable && \(/);
  assert.doesNotMatch(source, /sheetSearch/);
});

test("planner choice overlays use the model picker's anchored phone presentation", async () => {
  const editor = await read("../widgets/PlannerTaskEditor.tsx");
  for (const file of ["PlannerOnceSheet.tsx", "PlannerRecurrenceSheet.tsx", "PlannerRunBehaviorSheet.tsx"]) {
    const source = await read(`../widgets/${file}`);
    assert.match(source, /anchorRef: RefObject<HTMLElement \| null>/, file);
    assert.match(source, /phone="popover"/, file);
    assert.match(source, /stableAnchor/, file);
  }
  assert.match(editor, /projectTriggerRef/);
  assert.match(editor, /onceTriggerRef/);
  assert.match(editor, /recurrenceTriggerRef/);
  assert.match(editor, /behaviorTriggerRef/);
});

test("create defaults to a rounded once cadence and disables invalid sheet actions", async () => {
  const editor = await read("../widgets/PlannerTaskEditor.tsx");
  const onceSheet = await read("../widgets/PlannerOnceSheet.tsx");
  assert.match(editor, /: defaultOnceView\(\)/);
  assert.match(editor, /disabled:\s*!canSubmit \|\| busy/);
  assert.match(editor, /PlannerOnceSheet/);
  assert.doesNotMatch(editor, /type="datetime-local"/);
  assert.match(editor, /<Tabs/);
  assert.match(editor, /\{ id: "once", label: tr\("scheduleview.once"\)/);
  assert.match(editor, /\{ id: "every", label: tr\("scheduleview.every"\)/);
  assert.match(onceSheet, /type="date"/);
  assert.match(onceSheet, /type="time"/);
  assert.doesNotMatch(onceSheet, /datetime-local/);
  assert.match(editor, /id: "run"/);
  assert.match(editor, /id: "runs"/);
  assert.match(editor, /id: "duplicate"/);
  assert.match(editor, /id: "delete"/);
});

test("edit save stays gated on dirty and valid project-owned session", async () => {
  const editor = await read("../widgets/PlannerTaskEditor.tsx");
  assert.match(editor, /canSubmitPlannerEditor\(/);
  assert.match(editor, /sessionIdAfterProjectChange/);
  assert.match(editor, /weeklyViewFromOnce/);
  assert.match(editor, /disabled=\{!canSubmit \|\| busy\}/);
});

test("paused and unscheduled rows do not repeat the group heading in the time column", async () => {
  const shared = await read("../widgets/plannerShared.ts");
  const row = await read("../widgets/PlannerTaskRow.tsx");
  assert.match(shared, /groupKind === "paused" \|\| groupKind === "unscheduled" \|\| groupKind === "completed"/);
  assert.match(row, /formatTaskTime\(task\.nextRunAt \?\? 0, now, groupKind\)/);
  assert.doesNotMatch(row, /tr\("scheduleview.paused"\)/);
  assert.doesNotMatch(row, /tr\("scheduleview.noUpcomingRun"\)/);
});

test("completed Once rows do not render an active ON switch", async () => {
  const row = await read("../widgets/PlannerTaskRow.tsx");
  assert.match(row, /plannerRowShowsActiveSwitch/);
  assert.match(row, /showActiveSwitch &&/);
  assert.doesNotMatch(row, /scheduleview.taskCompleted/);
  assert.match(row, /\.\.\.\(!completed/);
});

test("Once sheet uses Polyth date and time rows over browser datetime chrome", async () => {
  const onceSheet = await read("../widgets/PlannerOnceSheet.tsx");
  const native = await read("../widgets/PlannerNativeField.tsx");
  const en = await read("../src/i18n/en.ts");
  assert.match(onceSheet, /scheduleview.date/);
  assert.match(onceSheet, /scheduleview.time/);
  assert.match(native, /type: "date" \| "time" \| "number"/);
  assert.match(en, /"scheduleview.date": "Date"/);
});

test("monthly day 29–31 summary does not claim every month", async () => {
  const shared = await read("../widgets/plannerShared.ts");
  const en = await read("../src/i18n/en.ts");
  assert.match(shared, /monthlyDayNeedsApplicableMonthsCopy/);
  assert.match(shared, /scheduleview.monthlyOnDayApplicableAtValue/);
  assert.match(en, /Day \{day\} of applicable months/);
  assert.doesNotMatch(en, /"scheduleview.monthlyOnDayApplicableAtValue": "Every month/);
});

test("duplicate preserves enabled instead of forcing live copies", async () => {
  const actions = await read("../widgets/plannerTaskActions.ts");
  assert.match(actions, /duplicatePlannerTaskInput\(task\)/);
  assert.doesNotMatch(actions, /enabled:\s*true/);
});

test("main chrome keeps project primary and status secondary", async () => {
  const view = await read("../widgets/PlannerView.tsx");
  const row = await read("../widgets/PlannerTaskRow.tsx");
  const shared = await read("../widgets/plannerShared.ts");
  const css = await read("../widgets/styles.css");
  assert.match(view, /planner-status-label/);
  assert.doesNotMatch(view, /FilterIcon/);
  assert.doesNotMatch(view, /summaryNext/);
  assert.doesNotMatch(view, /<Tabs/);
  assert.doesNotMatch(view, /plannerMore/);
  assert.match(view, /recentlyCompleted/);
  assert.match(css, /\.planner-canvas \{[\s\S]*max-width:\s*52rem;/);
  assert.match(css, /--subheader-font-size/);
  assert.match(row, /PlannerProjectMark/);
  assert.match(row, /includeTime: false/);
  assert.match(shared, /everyWeekdayValue/);
});

test("editor keeps explicit Once/Every and a sunken task field", async () => {
  const editor = await read("../widgets/PlannerTaskEditor.tsx");
  const css = await read("../widgets/styles.css");
  assert.match(editor, /scheduleview.once/);
  assert.match(editor, /scheduleview.every/);
  assert.match(editor, /scheduleview.runBehavior/);
  assert.match(editor, /compact:\s*true/);
  assert.match(css, /planner-prompt[\s\S]*var\(--sunken\)/);
});
