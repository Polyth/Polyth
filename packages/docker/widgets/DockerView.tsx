import { useState } from "react";
import type { SurfaceComponentProps, WebPackageHost } from "@polyth/web-sdk";
import { ToolCommandDialog, toolQuery, useProjectToolScope, useToolCommand, useToolSnapshot } from "@polyth/terminal/tool-ui";
import type { DockerAction, DockerSnapshot } from "../src/types.ts";
import { dockerText, type DockerMessageKey } from "../src/i18n/index.ts";

export default function DockerView(props: SurfaceComponentProps & { host: WebPackageHost }) {
  const scope = useProjectToolScope(props.host, props);
  return <DockerWorkspace key={`${scope.projectId}:${scope.sessionId}`} host={props.host} {...scope} />;
}

function DockerWorkspace({ host, projectId, sessionId }: { host: WebPackageHost; projectId: string | null; sessionId: string | null }) {
  const tr = (key: DockerMessageKey, values?: Record<string, string | number>) => dockerText(host, key, values);
  const [repositoryId, setRepository] = useState("");
  const [file, setFile] = useState("");
  const { data, error, loading, refresh } = useToolSnapshot<DockerSnapshot>(host, projectId ? `/api/docker/workspace?${toolQuery({ projectId, sessionId, repositoryId, file })}` : "");
  const command = useToolCommand(host, "/api/docker/command", `${projectId}:${sessionId}:${repositoryId}:${file}`);
  const { Button, Select, EmptyState, WorkspaceSurfaceHeader: Header, ResourceLink } = host.ui.components;
  if (!projectId) return <EmptyState title={tr("docker.empty.chooseProject.title")} description={tr("docker.empty.chooseProject.description")} />;
  const scopePicker = data && <Select label={tr("docker.select.repository")} value={data.scope.repositoryId} options={data.scope.repositories.map((row) => ({ value: row.id, label: row.alias, detail: row.available ? undefined : tr("docker.select.checkoutUnavailable") }))} onChange={(id: string) => { setRepository(id); setFile(""); }} />;
  const actions = <Button size="sm" busy={loading} onClick={refresh}>{tr("docker.action.refresh")}</Button>;
  const prepare = (action: DockerAction, selected = data?.selectedCompose) => {
    if (data && selected) void command.prepare({ ...data.scope, action, file: selected });
  };
  const running = data?.containers.filter((row) => row.state === "running").length ?? 0;
  const serviceNames = data ? [...new Set([...data.services, ...data.containers.map((row) => row.service || row.name)])] : [];
  return <div className="pkg-docker" aria-busy={loading}>
    {Header ? <Header scope={scopePicker} actions={actions} label={tr("docker.header.label")} /> : <div className="pkg-docker__toolbar">{scopePicker}{actions}</div>}
    {error && <p className="pkg-docker__error" role="alert">{error}</p>}
    {loading && <p className="pkg-docker__hint" role="status">{tr("docker.loading")}</p>}
    {data && <>
      <div className="pkg-docker__overview">
        <div><span className="pkg-docker__eyebrow">{tr("docker.overview.eyebrow")}</span><h2>{data.cli.available && data.selectedCompose && !data.runtimeMessage ? tr("docker.overview.running", { running, total: data.containers.length }) : tr("docker.overview.projectEnvironment")}</h2><p>{data.scope.alias}<span> · </span>{sessionId ? tr("docker.context.scopeSession") : tr("docker.context.scopeProject")}</p></div>
        <span className={`pkg-docker__status ${data.cli.available && !data.runtimeMessage ? "pkg-docker__status--ready" : ""}`}>{data.cli.available ? data.runtimeMessage ? tr("docker.status.engineNeedsAttention") : tr("docker.status.available") : tr("docker.status.cliUnavailable")}</span>
      </div>
      {!data.cli.available && <p className="pkg-docker__notice">{data.cli.reason !== "read-only-preview" ? tr("docker.notice.installDocker", { message: data.cli.message ?? "" }) : data.cli.message}</p>}
      {data.cli.available && !data.compose.available && <p className="pkg-docker__notice">{tr("docker.notice.composeUnavailable")}</p>}
      {data.runtimeMessage && <p className="pkg-docker__notice" role="status">{data.runtimeMessage}</p>}
      {data.composeFiles.length > 0 && <>
        <div className="pkg-docker__toolbar">
          <Select label={tr("docker.select.composeFile")} value={data.selectedCompose ?? ""} options={data.composeFiles.map((path) => ({ value: path, label: path }))} onChange={(path: string) => setFile(path)} />
          <div className="pkg-docker__actions"><Button size="sm" variant="primary" disabled={!data.compose.available || command.busy} onClick={() => prepare("up")}>{tr("docker.action.start")}</Button><Button size="sm" disabled={!data.compose.available || command.busy} onClick={() => prepare("stop")}>{tr("docker.action.stop")}</Button><Button size="sm" disabled={!data.compose.available || command.busy} onClick={() => prepare("restart")}>{tr("docker.action.restart")}</Button><Button size="sm" variant="ghost" disabled={!data.compose.available || command.busy} onClick={() => prepare("logs")}>{tr("docker.action.logs")}</Button></div>
        </div>
        <p className="pkg-docker__hint">{tr("docker.hint.onlyCompose")}</p>
        {serviceNames.length > 0 ? <ul className="pkg-docker__services">{serviceNames.map((name) => {
          const containers = data.containers.filter((row) => (row.service || row.name) === name);
          const serviceRunning = containers.filter((row) => row.state === "running").length;
          return <li key={name}><div className="pkg-docker__service-heading"><strong>{name}</strong><span className={containers.some((row) => row.state === "running") ? "pkg-docker__healthy" : "pkg-docker__hint"}>{containers.length ? tr("docker.service.runningCount", { running: serviceRunning, total: containers.length }) : tr("docker.service.notCreated")}</span></div>
            {containers.map((row) => <div className="pkg-docker__container" key={row.id}><code>{row.image}</code><span>{row.status}</span>{row.ports && <code className="pkg-docker__ports">{row.ports}</code>}<span className="pkg-docker__hint">{row.name} · {row.id}</span></div>)}
          </li>;
        })}</ul> : <EmptyState title={tr("docker.empty.noServices.title")} description={data.runtimeMessage ?? tr("docker.empty.noServices.description")} />}
      </>}
      {data.dockerfiles.length > 0 && <section className="pkg-docker__builds"><h3>{tr("docker.builds.heading")}</h3><ul>{data.dockerfiles.map((path) => <li key={path}>{ResourceLink ? <ResourceLink resource={{ scheme: "file", locator: path, projectId, sessionId, repositoryId: data.scope.repositoryId }}>{path}</ResourceLink> : <code>{path}</code>}<Button size="sm" disabled={!data.cli.available || command.busy} onClick={() => prepare("build", path)}>{tr("docker.action.build")}</Button></li>)}</ul></section>}
      {!data.composeFiles.length && !data.dockerfiles.length && <EmptyState title={tr("docker.empty.noConfig.title")} description={tr("docker.empty.noConfig.description")} actionLabel={tr("docker.empty.noConfig.action")} onAction={() => host.conversation.insert("Help me add a Docker environment for this project. Inspect the application first, then propose a Dockerfile and Compose services that fit its local development workflow.")} />}
      {data.truncated && <p className="pkg-docker__notice">{tr("docker.notice.truncated")}</p>}
    </>}
    {command.error && <p className="pkg-docker__error" role="alert">{command.error}</p>}
    {command.preview && <ToolCommandDialog host={host} preview={command.preview} onClose={command.close} />}
  </div>;
}
