/**
 * Canonical English messages owned by the docker package. Every other locale
 * in this directory is checked against these keys.
 */
export const en = {
  "docker.surface.description": "See project services, containers and ports; run Compose workflows in Terminal.",
  "docker.capability.plainDescription": "Inspect and manage your project's local container environment.",
  "docker.empty.chooseProject.title": "Choose a project",
  "docker.empty.chooseProject.description": "Open a local project to inspect its Docker environment.",
  "docker.select.repository": "Repository",
  "docker.select.checkoutUnavailable": "Checkout unavailable",
  "docker.action.refresh": "Refresh",
  "docker.header.label": "Docker workspace",
  "docker.loading": "Inspecting the project environment…",
  "docker.overview.eyebrow": "Local environment",
  "docker.overview.running": "{running} running / {total} containers",
  "docker.overview.projectEnvironment": "Project environment",
  "docker.context.scopeSession": "Session checkout",
  "docker.context.scopeProject": "Project checkout",
  "docker.status.engineNeedsAttention": "Engine needs attention",
  "docker.status.available": "Docker available",
  "docker.status.cliUnavailable": "CLI unavailable",
  "docker.notice.installDocker": "{message} Install Docker on the Polyth host, then refresh.",
  "docker.notice.composeUnavailable": "Docker Compose is unavailable. Install the Compose plugin to manage services.",
  "docker.select.composeFile": "Compose file",
  "docker.action.start": "Start",
  "docker.action.stop": "Stop",
  "docker.action.restart": "Restart",
  "docker.action.logs": "Logs",
  "docker.action.build": "Build",
  "docker.hint.onlyCompose": "Only containers belonging to this Compose file are shown. Refresh after a terminal command completes.",
  "docker.service.runningCount": "{running}/{total} running",
  "docker.service.notCreated": "Not created",
  "docker.empty.noServices.title": "No services to show yet",
  "docker.empty.noServices.description": "Start the Compose stack, then refresh to see its containers and ports.",
  "docker.builds.heading": "Build images",
  "docker.empty.noConfig.title": "No Docker configuration yet",
  "docker.empty.noConfig.description": "Add a compose.yaml for your app and its supporting services, or a Dockerfile to build an image.",
  "docker.empty.noConfig.action": "Draft with agent",
  "docker.notice.truncated": "The repository scan reached its depth or file limit. Some configurations may be omitted.",
} as const;

export type DockerMessageKey = keyof typeof en;
export type DockerMessages = Record<DockerMessageKey, string>;
