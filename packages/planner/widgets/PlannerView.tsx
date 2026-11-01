import { useCallback, useEffect, useRef, useState } from "react";
import type { WebPackageHost } from "@polyth/web-sdk";
import { openSettingsPage, useStore } from "../../../apps/web/src/store.ts";
import { Button, confirmAlert, EmptyState, Skeleton } from "../../../apps/web/src/components/ui/index.ts";
import type { PlannerTask } from "../src/model.ts";
import { plannerScopeForPick, resolvePlannerScope, type PlannerScope } from "../src/plannerList.ts";
import { subscribePlannerTaskRequests, takePlannerTaskRequest } from "./plannerOpen.ts";
import { plannerTasksSnapshot, refreshPlannerTasks, subscribePlannerTasks } from "./plannerTasks.ts";
import PlannerList, { type PlannerTab } from "./PlannerList.tsx";
import PlannerTaskPage, { type PlannerSeed } from "./PlannerTaskPage.tsx";
import type { PlannerTemplate } from "./plannerTemplates.ts";
import { t, usePlannerLocale } from "./plannerText.ts";

type Route = { kind: "list" } | { kind: "task"; id: string } | { kind: "new"; seed?: PlannerSeed; key: number };

const PREFS_KEY = "polyth.planner.view";
const REFRESH_MS = 15_000;

interface ViewPrefs { scope: PlannerScope; tab: PlannerTab }

function readScope(value: unknown): PlannerScope {
  if (value === "all") return "all";
  const projectId = (value as { projectId?: unknown } | null)?.projectId;
  return typeof projectId === "string" && projectId ? { projectId } : "current";
}

function readPrefs(): ViewPrefs {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(PREFS_KEY) ?? "{}") as { scope?: unknown; tab?: unknown };
    return {
      scope: readScope(parsed.scope),
      tab: parsed.tab === "paused" || parsed.tab === "done" ? parsed.tab : "upcoming",
    };
  } catch {
    return { scope: "current", tab: "upcoming" };
  }
}

function writePrefs(prefs: ViewPrefs): void {
  try { sessionStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* presentation only */ }
}

export default function PlannerView({ host, projectId: shellProjectId }: {
  host?: WebPackageHost;
  /** The shell's workspace project; the list shows it unless the person picks
   *  another scope. Absent, the active project stands in. */
  projectId?: string | null;
} = {}) {
  const locale = usePlannerLocale();
  const projects = useStore((state) => state.projectRegistry.projects);
  const activeProjectId = useStore((state) => state.activeProjectId);
  const currentProjectId = shellProjectId ?? activeProjectId;
  const [tasks, setTasks] = useState<PlannerTask[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [prefs, setPrefs] = useState<ViewPrefs>(readPrefs);
  const [route, setRoute] = useState<Route>({ kind: "list" });
  const [now, setNow] = useState(() => Date.now());
  const [freshId, setFreshId] = useState<string | null>(null);
  const dirty = useRef(false);
  const ticket = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const onDirtyChange = useCallback((value: boolean) => { dirty.current = value; }, []);

  const reload = useCallback(async () => {
    const mine = ++ticket.current;
    try {
      // The shared snapshot: a chat's schedule line reads the same list.
      const next = await refreshPlannerTasks();
      if (mine !== ticket.current) return;
      setTasks([...next]);
      setLoadError("");
    } catch (cause) {
      if (mine !== ticket.current) return;
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mine === ticket.current) setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void reload();
    }, REFRESH_MS);
    // Countdowns move between refreshes.
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => { clearInterval(timer); clearInterval(clock); ticket.current += 1; };
  }, [reload]);

  // A change made elsewhere (a chat's schedule line, an agent's call) lands
  // in the shared snapshot; the list follows it.
  useEffect(() => subscribePlannerTasks(() => {
    const next = plannerTasksSnapshot().tasks;
    if (next) setTasks([...next]);
  }), []);

  useEffect(() => {
    if (!freshId) return;
    const timer = setTimeout(() => setFreshId(null), 2400);
    return () => clearTimeout(timer);
  }, [freshId]);

  // A task deleted here or elsewhere takes its page with it.
  useEffect(() => {
    if (route.kind === "task" && tasks && !tasks.some((task) => task.id === route.id)) {
      dirty.current = false;
      setRoute({ kind: "list" });
    }
  }, [route, tasks]);

  // A picked project that no longer exists falls back to the current one.
  const pickedId = typeof prefs.scope === "object" ? prefs.scope.projectId : null;
  useEffect(() => {
    if (pickedId && projects.length > 0 && !projects.some((project) => project.id === pickedId)) {
      setPrefs((current) => ({ ...current, scope: "current" }));
    }
  }, [pickedId, projects]);
  const projectIds = projects.map((project) => project.id);
  const scopedProjectId = resolvePlannerScope(prefs.scope, currentProjectId, projectIds);

  const updatePrefs = (next: Partial<ViewPrefs>) => {
    setPrefs((current) => {
      const merged = { ...current, ...next };
      writePrefs(merged);
      return merged;
    });
  };

  const navigate = async (next: Route) => {
    if (dirty.current && route.kind !== "list") {
      const leave = await confirmAlert(t("editor.unsavedBody"), {
        title: t("editor.unsavedTitle"),
        confirmLabel: t("editor.discard"),
        destructive: true,
      });
      if (!leave) return;
      dirty.current = false;
    }
    setRoute(next);
    rootRef.current?.closest(".rail-body, .wb-surface-mount, .module-view-content")?.scrollTo?.({ top: 0 });
  };

  // "Open in Planner" from a chat shows that task's page, now or as soon as
  // this pane mounts.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    const take = () => {
      const id = takePlannerTaskRequest();
      if (id) void navigateRef.current({ kind: "task", id });
    };
    take();
    return subscribePlannerTaskRequests(take);
  }, []);

  const defaultProjectId = scopedProjectId
    ?? resolvePlannerScope("current", currentProjectId, projectIds)
    ?? projects[0]?.id ?? "";
  const openNew = (seed?: PlannerSeed) => void navigate({
    kind: "new",
    key: Date.now(),
    seed: { projectId: defaultProjectId, ...seed },
  });
  const openTemplate = (template: PlannerTemplate) => openNew({
    title: t(template.title),
    prompt: t(template.prompt),
    view: template.view(),
  });
  const changed = (task?: PlannerTask) => {
    if (task) setTasks((current) => current?.map((item) => item.id === task.id ? task : item) ?? current);
    void reload();
  };

  let body;
  if (projects.length === 0) {
    body = (
      <EmptyState
        title={t("list.noProjects")}
        description={t("list.noProjectsBody")}
        actionLabel={t("list.openProjects")}
        onAction={() => openSettingsPage("projects")}
      />
    );
  } else if (tasks === null && loadError) {
    body = (
      <div className="planner-quiet planner-quiet--error" role="alert">
        <p className="planner-quiet-title">{t("list.couldNotLoad")}</p>
        <p className="planner-quiet-body">{loadError}</p>
        <Button size="sm" onClick={() => void reload()}>{t("list.retry")}</Button>
      </div>
    );
  } else if (tasks === null) {
    body = (
      <div className="planner-loading" aria-busy="true">
        <Skeleton shape="block" />
        <Skeleton shape="text" />
        <Skeleton shape="text" />
        <Skeleton shape="text" />
      </div>
    );
  } else if (route.kind === "list") {
    body = (
      <PlannerList
        tasks={tasks}
        projects={projects}
        projectId={scopedProjectId}
        tab={prefs.tab}
        locale={locale}
        now={now}
        freshId={freshId}
        onProject={(projectId) => updatePrefs({ scope: plannerScopeForPick(projectId ?? "", currentProjectId) })}
        onTab={(tab) => updatePrefs({ tab })}
        onOpen={(task) => void navigate({ kind: "task", id: task.id })}
        onCreate={() => openNew()}
        onTemplate={openTemplate}
        onChanged={changed}
      />
    );
  } else {
    const task = route.kind === "task" ? tasks.find((item) => item.id === route.id) ?? null : null;
    if (route.kind === "task" && !task) {
      body = null;
    } else {
      body = (
        <PlannerTaskPage
          key={route.kind === "task" ? route.id : `new-${route.key}`}
          task={task}
          {...(route.kind === "new" && route.seed ? { seed: route.seed } : {})}
          projects={projects}
          locale={locale}
          now={now}
          {...(host ? { host } : {})}
          onBack={() => void navigate({ kind: "list" })}
          onDirtyChange={onDirtyChange}
          onDuplicated={(copy) => {
            setTasks((current) => current ? [...current, copy] : [copy]);
            void navigate({ kind: "task", id: copy.id });
          }}
          onSaved={(saved, created) => {
            setTasks((current) => {
              if (!current) return [saved];
              return current.some((item) => item.id === saved.id)
                ? current.map((item) => item.id === saved.id ? saved : item)
                : [...current, saved];
            });
            if (created) {
              dirty.current = false;
              setFreshId(saved.id);
              // A new task lands where it will appear.
              updatePrefs({ tab: saved.enabled ? "upcoming" : "paused" });
              setRoute({ kind: "list" });
            }
            void reload();
          }}
        />
      );
    }
  }

  return (
    <div ref={rootRef} className="planner" data-route={route.kind}>
      <div className="planner-canvas">{body}</div>
    </div>
  );
}
