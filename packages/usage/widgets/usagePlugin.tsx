import { useMemo, type ReactNode } from "react";
import { tr } from "../../../apps/web/src/i18n/index.ts";
import { useStore } from "../../../apps/web/src/store.ts";
import {
  defineWidgetPlugin,
  registerWidgetPlugin,
  type PluginWidgetDef,
  type WidgetAvailabilityContext,
  type WidgetPlugin,
  type WidgetRenderContext,
} from "../../../apps/web/src/widgets/catalog.ts";
import { USAGE_WIDGETS } from "./catalog.ts";
import { useSessionContext } from "./contextUsage.ts";
import { LimitsWidget, LimitsWidgetSettings } from "./usage/LimitsWidget.tsx";
import { UsageWidget, UsageWidgetSettings } from "./usage/UsageWidget.tsx";
import { usageWidgetPreferences } from "./usage/widgetPresentation.ts";
import { limitsWidgetPreferences } from "./usage/limitsModel.ts";
import type { UsageStatsQuery } from "../src/analytics/contracts.ts";

type Translate = (key: string, values?: Record<string, string | number>) => string;

const defaultTranslate: Translate = (key, values) => tr(key as Parameters<typeof tr>[0], values);

const widgetCopy: Record<string, { title: string; description: string }> = {
  "usage.session": { title: "usage.sessionWidgetTitle", description: "usage.sessionWidgetDescription" },
  "usage.project": { title: "usage.projectWidgetTitle", description: "usage.projectWidgetDescription" },
  "usage.global": { title: "usage.globalWidgetTitle", description: "usage.globalWidgetDescription" },
  "usage.limits": { title: "usage.limitsWidgetTitle", description: "usage.limitsWidgetDescription" },
};

const timezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

function SessionUsageWidget(props: WidgetRenderContext) {
  const { sessionId } = props;
  const activeSessionId = useStore((state) => state.activeSessionId);
  const resolved = sessionId ?? activeSessionId;
  const session = useStore((state) => state.sessions.find((item) => item.id === resolved) ?? null);
  const context = useSessionContext(session);
  const query = useMemo<UsageStatsQuery>(() => ({
    range: "all",
    timezone: timezone(),
    ...(resolved ? { sessionIds: [resolved] } : {}),
    detailLimit: 20,
    detailSort: "activity",
  }), [resolved]);
  return <UsageWidget {...props} scope="session" title={session?.title} query={query} enabled={!!resolved} context={context} session={session} />;
}

function ProjectUsageWidget(props: WidgetRenderContext) {
  const { projectId, config } = props;
  const activeProjectId = useStore((state) => state.activeProjectId);
  const resolved = projectId ?? activeProjectId;
  const title = useStore((state) => state.projectRegistry.projects.find((project) => project.id === resolved)?.name);
  const { range } = usageWidgetPreferences(config, "project");
  const query = useMemo<UsageStatsQuery>(() => ({
    range,
    timezone: timezone(),
    ...(resolved ? { projectIds: [resolved] } : {}),
    detailLimit: 20,
    detailSort: "activity",
  }), [resolved, range]);
  return <UsageWidget {...props} scope="project" title={title} query={query} enabled={!!resolved} />;
}

function GlobalUsageWidget(props: WidgetRenderContext) {
  const { range } = usageWidgetPreferences(props.config, "global");
  const query = useMemo<UsageStatsQuery>(() => ({
    range,
    timezone: timezone(),
    detailLimit: 12,
    detailSort: "activity",
  }), [range]);
  return <UsageWidget {...props} scope="global" query={query} enabled />;
}

function LimitsWidgetWrapper(props: WidgetRenderContext) {
  const { sessionId } = props;
  const activeSessionId = useStore((state) => state.activeSessionId);
  const resolved = sessionId ?? activeSessionId;
  const session = useStore((state) => state.sessions.find((item) => item.id === resolved) ?? null);
  return <LimitsWidget {...props} session={session} />;
}

const RENDERERS: Record<string, (context: WidgetRenderContext) => ReactNode> = {
  "usage.session": (context) => <SessionUsageWidget {...context} />,
  "usage.project": (context) => <ProjectUsageWidget {...context} />,
  "usage.global": (context) => <GlobalUsageWidget {...context} />,
  "usage.limits": (context) => <LimitsWidgetWrapper {...context} />,
};

/** Session-scope cards have nothing to show without an active session, so the
 *  hosts omit them entirely instead of painting an empty "No active session"
 *  card. Limits only needs one in its default `current` source. */
const AVAILABILITY: Record<string, (context: WidgetAvailabilityContext) => boolean> = {
  "usage.session": ({ sessionId }) => sessionId !== null,
  "usage.limits": ({ sessionId, config }) => sessionId !== null || limitsWidgetPreferences(config).source !== "current",
};

export function createUsageWidgetPlugin(translate: Translate = defaultTranslate): WidgetPlugin {
  return defineWidgetPlugin<WidgetPlugin>({
    id: "usage",
    name: translate("usage.name"),
    widgets: USAGE_WIDGETS.map(({ module, ...definition }): PluginWidgetDef => {
      const copy = widgetCopy[definition.id];
      const isAvailable = AVAILABILITY[module];
      return {
        ...definition,
        ...(copy ? { title: translate(copy.title), description: translate(copy.description) } : {}),
        ...(isAvailable ? { isAvailable } : {}),
        category: translate("usage.name"),
        render: RENDERERS[module]!,
        settingsRender: (context) => module === "usage.limits"
          ? <LimitsWidgetSettings {...context} />
          : <UsageWidgetSettings {...context} />,
      };
    }),
  });
}


export const USAGE_WIDGET_PLUGIN = createUsageWidgetPlugin();

let uninstall: (() => void) | null = null;

export function installUsagePlugin(translate: Translate = defaultTranslate): () => void {
  if (uninstall) return uninstall;
  const unregister = registerWidgetPlugin(translate === defaultTranslate ? USAGE_WIDGET_PLUGIN : createUsageWidgetPlugin(translate));
  const current = () => {
    unregister();
    if (uninstall === current) uninstall = null;
  };
  uninstall = current;
  return current;
}
