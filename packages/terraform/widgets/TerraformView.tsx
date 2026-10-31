import { useState } from "react";
import type { SurfaceComponentProps, WebPackageHost } from "@polyth/web-sdk";
import { ToolCommandDialog, toolQuery, useProjectToolScope, useToolCommand, useToolSnapshot } from "@polyth/terminal/tool-ui";
import type { TerraformAction, TerraformPlanSummary, TerraformSnapshot } from "../src/types.ts";
import { terraformText, type TerraformMessageKey } from "../src/i18n/index.ts";

export default function TerraformView(props: SurfaceComponentProps & { host: WebPackageHost }) {
  const scope = useProjectToolScope(props.host, props);
  return <TerraformWorkspace key={`${scope.projectId}:${scope.sessionId}`} host={props.host} {...scope} />;
}

function TerraformWorkspace({ host, projectId, sessionId }: { host: WebPackageHost; projectId: string | null; sessionId: string | null }) {
  const tr = (key: TerraformMessageKey, values?: Record<string, string | number>) => terraformText(host, key, values);
  const [repositoryId, setRepository] = useState("");
  const [selectedRoot, setRoot] = useState("");
  const [selectedPlan, setPlan] = useState("");
  const query = toolQuery({ projectId, sessionId, repositoryId });
  const { data, error, loading, refresh } = useToolSnapshot<TerraformSnapshot>(host, projectId ? `/api/terraform/workspace?${query}` : "");
  const root = data?.roots.find((row) => row.directory === selectedRoot) ?? data?.roots[0];
  const plan = useToolSnapshot<TerraformPlanSummary>(host, data && selectedPlan ? `/api/terraform/plan?${toolQuery({ projectId, sessionId, repositoryId: data.scope.repositoryId, file: selectedPlan })}` : "");
  const command = useToolCommand(host, "/api/terraform/command", `${projectId}:${sessionId}:${repositoryId}:${root?.directory}`);
  const { Button, Select, EmptyState, WorkspaceSurfaceHeader: Header, ResourceLink } = host.ui.components;
  if (!projectId) return <EmptyState title={tr("terraform.empty.chooseProject.title")} description={tr("terraform.empty.chooseProject.description")} />;
  const scopePicker = data && <Select label={tr("terraform.select.repository")} value={data.scope.repositoryId} options={data.scope.repositories.map((row) => ({ value: row.id, label: row.alias, detail: row.available ? undefined : tr("terraform.select.checkoutUnavailable") }))} onChange={(id: string) => { setRepository(id); setRoot(""); setPlan(""); }} />;
  const actions = <Button size="sm" busy={loading} onClick={refresh}>{tr("terraform.action.refresh")}</Button>;
  const prepare = (action: TerraformAction) => { if (data && root) void command.prepare({ ...data.scope, directory: root.directory, action }); };
  return <div className="pkg-terraform" aria-busy={loading}>
    {Header ? <Header scope={scopePicker} actions={actions} label={tr("terraform.header.label")} /> : <div className="pkg-terraform__controls">{scopePicker}{actions}</div>}
    {error && <p className="pkg-terraform__error" role="alert">{error}</p>}
    {loading && <p className="pkg-terraform__hint" role="status">{tr("terraform.loading")}</p>}
    {data && <>
      <div className="pkg-terraform__context"><span className="pkg-terraform__eyebrow">{tr("terraform.context.eyebrow")}</span><h2>{tr("terraform.context.configurations", { count: data.roots.length })}</h2><p>{data.scope.alias}<span> · </span>{sessionId ? tr("terraform.context.scopeSession") : tr("terraform.context.scopeProject")}{data.cli.version ? <><span> · </span>{tr("terraform.context.cliVersion", { version: data.cli.version })}</> : null}</p></div>
      {!data.cli.available && <p className="pkg-terraform__notice">{tr("terraform.cli.unavailableNote", { message: data.cli.message ?? "" })}</p>}
      {root && <>
        <div className="pkg-terraform__controls"><Select label={tr("terraform.select.configuration")} value={root.directory} options={data.roots.map((row) => ({ value: row.directory, label: row.directory === "." ? tr("terraform.select.repositoryRoot") : row.directory, detail: tr("terraform.select.fileCount", { count: row.files.length }) }))} onChange={(directory: string) => setRoot(directory)} /><span className="pkg-terraform__hint">{root.initialized ? tr("terraform.hint.initialized") : tr("terraform.hint.notInitialized")}</span></div>
        <div className="pkg-terraform__workflow"><Button size="sm" disabled={!data.cli.available || command.busy} onClick={() => prepare("init")}>{tr("terraform.action.initialize")}</Button><Button size="sm" disabled={!data.cli.available || command.busy} onClick={() => prepare("format-check")}>{tr("terraform.action.checkFormat")}</Button><Button size="sm" disabled={!data.cli.available || command.busy} onClick={() => prepare("validate")}>{tr("terraform.action.validate")}</Button><Button size="sm" variant="primary" disabled={!data.cli.available || command.busy} onClick={() => prepare("plan")}>{tr("terraform.action.createPlan")}</Button></div>
        <ul className="pkg-terraform__files">{root.files.map((file) => <li key={file}>{ResourceLink ? <ResourceLink resource={{ scheme: "file", locator: file, projectId, sessionId, repositoryId: data.scope.repositoryId }}>{file}</ResourceLink> : <code>{file}</code>}</li>)}</ul>
      </>}
      {data.roots.length === 0 && <EmptyState title={tr("terraform.empty.noConfiguration.title")} description={tr("terraform.empty.noConfiguration.description")} actionLabel={tr("terraform.empty.noConfiguration.action")} onAction={() => host.conversation.insert("Help me add Terraform infrastructure for this project. Inspect the project, clarify the provider and deployment needs, and propose a minimal configuration with a clear plan/review workflow.")} />}
      <section className="pkg-terraform__review"><div className="pkg-terraform__review-heading"><h3>{tr("terraform.review.heading")}</h3><span className="pkg-terraform__hint">{tr("terraform.review.scopeHint")}</span></div>
        {data.plans.length ? <Select label={tr("terraform.select.savedPlan")} value={selectedPlan} placeholder={tr("terraform.select.planPlaceholder")} options={data.plans.map((file) => ({ value: file, label: file }))} onChange={(file: string) => setPlan(file)} /> : <p className="pkg-terraform__hint">{tr("terraform.review.noPlans")}</p>}
        {plan.loading && <p role="status" className="pkg-terraform__hint">{tr("terraform.review.reading")}</p>}
        {plan.error && <p role="alert" className="pkg-terraform__error">{plan.error}</p>}
        {plan.data && <>
          {plan.data.errored && <p className="pkg-terraform__notice">{tr("terraform.review.errored")}</p>}
          <dl className="pkg-terraform__counts">{([["create", "terraform.count.create"], ["update", "terraform.count.update"], ["replace", "terraform.count.replace"], ["delete", "terraform.count.delete"]] as const).map(([key, label]) => <div key={key} className={`pkg-terraform__count pkg-terraform__count--${key}`}><dt>{tr(label)}</dt><dd>{plan.data!.counts[key]}</dd></div>)}</dl>
          {plan.data.changes.length ? <ul className="pkg-terraform__changes">{plan.data.changes.map((change, index) => <li key={`${change.address}:${index}`}><span className={`pkg-terraform__action pkg-terraform__action--${change.action}`}>{tr(`terraform.changeAction.${change.action}`)}</span><code>{change.address}</code></li>)}</ul> : <p className="pkg-terraform__hint">{tr("terraform.review.noChanges")}</p>}
          <p className="pkg-terraform__hint">{tr("terraform.review.snapshotNote")}</p>
        </>}
      </section>
      {data.truncated && <p className="pkg-terraform__notice">{tr("terraform.notice.truncated")}</p>}
    </>}
    {command.error && <p className="pkg-terraform__error" role="alert">{command.error}</p>}
    {command.preview && <ToolCommandDialog host={host} preview={command.preview} onClose={command.close} />}
  </div>;
}
