import { useCallback, useEffect, useMemo, useState } from "react";
import type { HarnessSnapshot } from "@polyth/contracts";
import type { HarnessNativeSkillDto, HarnessNativeSkillListDto } from "@polyth/contracts/capability-installations";
import { createApiTransport, type WebPackageHost } from "@polyth/web-sdk";
import { Badge, Button, Notice, RefreshIcon, Switch, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { EmptyState, ErrorState, Row, Section } from "../../../apps/web/src/components/settings/parts.tsx";

const api = createApiTransport();

const SOURCE_ORDER: HarnessNativeSkillDto["source"][] = ["project", "user", "plugin"];

/** The harness's own skills: inherit them into Polyth conversations, then mute
 *  any one of them. Polyth never edits the harness's skill folders. */
export default function HarnessSkills({ host, harnessId, snapshot, projectId }: {
  host: WebPackageHost;
  harnessId: string;
  snapshot?: HarnessSnapshot;
  projectId?: string | null;
}) {
  const [list, setList] = useState<HarnessNativeSkillListDto>();
  const [loadError, setLoadError] = useState<unknown>();
  const [busy, setBusy] = useState("");
  const [failure, setFailure] = useState("");
  const [query, setQuery] = useState("");
  const [canManage, setCanManage] = useState(true);
  const t = (key: string, values?: Record<string, string | number>) => host.ui.locale.translate(`harnessruntime.skills.${key}`, values);
  const sourceLabel = (source: HarnessNativeSkillDto["source"]) => t(`source.${source}`);
  const name = snapshot?.identity.name ?? harnessId;
  const path = `/api/harnesses/${encodeURIComponent(harnessId)}/skills${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`;

  const load = useCallback(async () => {
    try {
      setList(await api.get<HarnessNativeSkillListDto>(path));
      setLoadError(undefined);
    } catch (cause) {
      setLoadError(cause);
    }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let live = true;
    void api.get<{ manage: boolean }>("/api/harnesses/access").then((access) => { if (live) setCanManage(access.manage); }, () => {});
    return () => { live = false; };
  }, []);

  const update = async (key: string, patch: { inherit?: boolean; skill?: { name: string; enabled: boolean } }) => {
    setBusy(key);
    setFailure("");
    try {
      setList(await api.put<HarnessNativeSkillListDto>(path, patch));
    } catch (cause) {
      setFailure(host.errors.friendly(t("changeAction", { name }), cause));
      await load();
    } finally {
      setBusy("");
    }
  };

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const visible = (list?.skills ?? []).filter((skill) => !needle
      || skill.name.toLowerCase().includes(needle)
      || skill.description?.toLowerCase().includes(needle));
    return SOURCE_ORDER
      .map((source) => ({ source, skills: visible.filter((skill) => skill.source === source) }))
      .filter((group) => group.skills.length > 0);
  }, [list, query]);

  if (!list) {
    return <div className="pkg-harnesses-skills" aria-busy={!loadError}>
      {loadError
        ? <ErrorState compact title={t("loadTitle", { name })} error={loadError} onRetry={() => void load()} />
        : <EmptyState compact busy title={t("reading")} />}
    </div>;
  }

  const locked = Boolean(busy) || !canManage || !list.supported;
  const active = list.skills.filter((skill) => skill.enabled).length;
  return <div className="pkg-harnesses-skills" data-settings-item={`harness.${harnessId}.skills`}>
    {failure && <Notice tone="error" role="alert">{failure}</Notice>}
    {!list.supported && list.unsupportedReason && <Notice>{list.unsupportedReason}</Notice>}
    {list.supported && !canManage && <Notice>{t("ownerOnly", { name })}</Notice>}
    <Section title={t("title", { name })} hint={t("hint", { name })}
      action={<Button size="sm" variant="ghost" iconStart={RefreshIcon} busy={busy === "reload"} disabled={Boolean(busy)} onClick={() => { setBusy("reload"); void load().finally(() => setBusy("")); }}>{t("checkAgain")}</Button>}>
      <Row label={t("inheritLabel", { name })} hint={list.inherit ? t("inheritOn", { active, total: list.skills.length }) : t("inheritOff")}>
        <Switch label={t("inheritLabel", { name })} checked={list.inherit} disabled={locked} onChange={(inherit) => void update("inherit", { inherit })} />
      </Row>
    </Section>
    {list.skills.length === 0
      ? <EmptyState compact title={t("emptyTitle", { name })} body={t("emptyBody", { name })} />
      : <>
          {list.skills.length > 6 && <TextInput uiSize="sm" type="search" aria-label={t("filter")} placeholder={t("filter")} value={query} onChange={(event) => setQuery(event.target.value)} />}
          {groups.length === 0 && <p className="pkg-harnesses-help" role="status">{t("noMatch", { query: query.trim() })}</p>}
          {groups.map((group) => <section key={group.source} className="pkg-harnesses-skill-group" aria-label={sourceLabel(group.source)}>
            <h4>{sourceLabel(group.source)}<small>{group.skills.length}</small></h4>
            <ul className="pkg-harnesses-skill-list">
              {group.skills.map((skill) => <li key={skill.name} className="pkg-harnesses-skill" data-enabled={String(skill.enabled)}>
                <span className="pkg-harnesses-skill-text">
                  <span className="pkg-harnesses-skill-name"><code>/{skill.name}</code>{list.inherit && !skill.enabled && <Badge>{t("muted")}</Badge>}</span>
                  {skill.description && <small>{skill.description}</small>}
                </span>
                <Switch
                  label={t(skill.enabled ? "mute" : "use", { skill: skill.name })}
                  checked={skill.enabled}
                  disabled={locked || !list.inherit}
                  onChange={(enabled) => void update(`skill:${skill.name}`, { skill: { name: skill.name, enabled } })}
                />
              </li>)}
            </ul>
          </section>)}
        </>}
  </div>;
}
