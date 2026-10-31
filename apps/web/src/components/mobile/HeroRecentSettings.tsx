// Options for the fresh-chat Recent list. The list carries no heading and no
// chrome of its own: these options open inline under the Recent sessions row
// of the new chat's Customize panel (HeroCustomize.tsx). Every choice applies
// immediately and syncs with the hero widget preferences.
import type { ReactNode } from "react";
import { tr } from "../../i18n/index.ts";
import { useStore } from "../../store.ts";
import {
  HERO_RECENT_LIMITS,
  setHeroRecentPrefs,
  type HeroRecentFilter,
  type HeroRecentPrefs,
  type HeroRecentScope,
  type HeroRecentSize,
} from "../../heroWidgetPrefs.ts";
import { Seg } from "../settings/parts.tsx";
import { Checkbox, Switch, VisuallyHidden } from "../ui/index.ts";

function SizeGlyph({ size, label }: { size: HeroRecentSize; label: string }) {
  return (
    <>
      <span className="hero-recent-size-glyph" data-size={size} aria-hidden="true">A</span>
      <VisuallyHidden>{label}</VisuallyHidden>
    </>
  );
}

function SettingsRow({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="hero-recent-settings-row">
      <span className="hero-recent-settings-label" id={id}>{label}</span>
      {children}
    </div>
  );
}

export function HeroRecentOptions({
  prefs,
  currentProjectId,
}: {
  prefs: HeroRecentPrefs;
  currentProjectId: string | null;
}) {
  const projects = useStore((s) => s.projectRegistry.projects);
  const toggleProject = (id: string, checked: boolean) => setHeroRecentPrefs({
    projectIds: checked ? [...prefs.projectIds, id] : prefs.projectIds.filter((item) => item !== id),
  });
  // Choosing "Selected" for the first time starts from the project in view, so
  // the list never goes blank the moment the option is picked.
  const chooseScope = (scope: HeroRecentScope) => setHeroRecentPrefs(
    scope === "selected" && prefs.projectIds.length === 0 && currentProjectId
      ? { scope, projectIds: [currentProjectId] }
      : { scope },
  );

  return (
    <div className="hero-recent-settings-form">
      <SettingsRow label={tr("workspace.herorecent.count")} id="hero-recent-count">
        <Seg
          label={tr("workspace.herorecent.count")}
          value={prefs.limit}
          options={HERO_RECENT_LIMITS.map((limit) => [limit, String(limit)] as [number, string])}
          onChange={(limit) => setHeroRecentPrefs({ limit })}
        />
      </SettingsRow>
      <SettingsRow label={tr("workspace.herorecent.filter")} id="hero-recent-filter">
        <Seg<HeroRecentFilter>
          label={tr("workspace.herorecent.filter")}
          value={prefs.filter}
          options={[
            ["all", tr("workspace.herorecent.filterAll")],
            ["active", tr("workspace.herorecent.filterActive")],
            ["unread", tr("workspace.herorecent.filterUnread")],
          ]}
          onChange={(filter) => setHeroRecentPrefs({ filter })}
        />
      </SettingsRow>
      <SettingsRow label={tr("workspace.herorecent.subagents")} id="hero-recent-subagents">
        <Switch
          checked={prefs.subagents}
          labelledBy="hero-recent-subagents"
          onChange={(subagents) => setHeroRecentPrefs({ subagents })}
        />
      </SettingsRow>
      <SettingsRow label={tr("workspace.herorecent.projects")} id="hero-recent-projects">
        <Seg<HeroRecentScope>
          label={tr("workspace.herorecent.projects")}
          value={prefs.scope}
          options={[
            ["current", tr("workspace.herorecent.scopeCurrent")],
            ["all", tr("workspace.herorecent.scopeAll")],
            ["selected", tr("workspace.herorecent.scopeSelected")],
          ]}
          onChange={chooseScope}
        />
      </SettingsRow>
      {prefs.scope === "selected" && (
        <div className="hero-recent-settings-projects" role="group" aria-labelledby="hero-recent-projects">
          {projects.map((project) => (
            <Checkbox
              key={project.id}
              checked={prefs.projectIds.includes(project.id)}
              onChange={(checked) => toggleProject(project.id, checked)}
              label={project.name || project.path}
            />
          ))}
        </div>
      )}
      <SettingsRow label={tr("workspace.herorecent.textSize")} id="hero-recent-size">
        <Seg<HeroRecentSize>
          label={tr("workspace.herorecent.textSize")}
          value={prefs.size}
          options={[
            ["sm", <SizeGlyph size="sm" label={tr("workspace.herorecent.sizeSmall")} />],
            ["md", <SizeGlyph size="md" label={tr("workspace.herorecent.sizeMedium")} />],
            ["lg", <SizeGlyph size="lg" label={tr("workspace.herorecent.sizeLarge")} />],
          ]}
          onChange={(size) => setHeroRecentPrefs({ size })}
        />
      </SettingsRow>
    </div>
  );
}
