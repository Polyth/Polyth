import { dirname } from "node:path";
import { checkedToolPath, discoverToolFiles, projectToolCommand, toolError, type ToolRun } from "@polyth/terminal/project-tools";
import type { ProjectToolScope, ToolAvailability, ToolCommandPreview } from "@polyth/terminal/tool-types";
import type { DockerAction, DockerContainer, DockerSnapshot } from "./types.ts";

const COMPOSE = new Set(["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]);
export const isComposeFile = (name: string): boolean => COMPOSE.has(name);
export const isDockerfile = (name: string): boolean => name === "Dockerfile" || name.startsWith("Dockerfile.");
const value = (input: unknown): string => typeof input === "string" ? input.slice(0, 2048) : "";

/** ps JSON contains labels; project env/config/inspect payloads never enter the DTO. */
export function parseDockerContainers(output: string): DockerContainer[] {
  const rows: unknown[] = output.trim().startsWith("[") ? JSON.parse(output) : output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (!Array.isArray(rows)) throw toolError("unavailable", "Docker returned an unsupported container list.");
  return rows.slice(0, 200).map((raw) => {
    const row = raw as Record<string, unknown>;
    const labels = value(row.Labels).split(",");
    const service = labels.find((label) => label.startsWith("com.docker.compose.service="))?.slice("com.docker.compose.service=".length) ?? "";
    return { id: value(row.ID), name: value(row.Names), service, image: value(row.Image), state: value(row.State), status: value(row.Status), ports: value(row.Ports) };
  });
}

async function availability(run: ToolRun, args: string[], root: string, label: string): Promise<ToolAvailability> {
  try {
    const result = await run("docker", args, root);
    if (result.exitCode !== 0) return { available: false, message: `${label} is unavailable. Check the CLI installation.` };
    return { available: true, version: result.stdout.trim().slice(0, 160) };
  } catch (cause) {
    if ((cause as { reason?: string } | null)?.reason === "read-only-preview") return { available: false, reason: "read-only-preview", message: "CLI inspection is disabled in this read-only preview." };
    return { available: false, message: `${label} could not run. Check the CLI installation.` };
  }
}

export async function dockerSnapshot(scope: ProjectToolScope, run: ToolRun, selected?: string): Promise<DockerSnapshot> {
  const discovered = await discoverToolFiles(scope.root, (name) => isComposeFile(name) || isDockerfile(name));
  const composeFiles = discovered.files.filter((path) => isComposeFile(path.split("/").at(-1)!));
  const dockerfiles = discovered.files.filter((path) => isDockerfile(path.split("/").at(-1)!));
  if (selected && !composeFiles.includes(selected)) throw toolError("not-found", "Compose file not found in this repository.");
  const selectedCompose = selected ?? composeFiles[0] ?? null;
  const cli = await availability(run, ["--version"], scope.root, "Docker");
  const compose = cli.available ? await availability(run, ["compose", "version", "--short"], scope.root, "Docker Compose") : { available: false };
  const snapshot: DockerSnapshot = { scope, cli, compose, composeFiles, dockerfiles, selectedCompose, services: [], containers: [], truncated: discovered.truncated };
  if (!selectedCompose || !cli.available) return snapshot;
  const file = await checkedToolPath(scope.root, selectedCompose);
  const directory = dirname(file);
  if (compose.available) {
    try {
      const result = await run("docker", ["compose", "--project-directory", directory, "-f", file, "config", "--services"], scope.root);
      if (result.exitCode === 0) snapshot.services = result.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean).slice(0, 200);
      else snapshot.runtimeMessage = "Compose configuration could not be read. Check it in the terminal.";
    } catch { snapshot.runtimeMessage = "Compose configuration could not be read. Check it in the terminal."; }
  }
  try {
    const result = await run("docker", ["ps", "--all", "--filter", `label=com.docker.compose.project.working_dir=${directory}`, "--filter", `label=com.docker.compose.project.config_files=${file}`, "--format", "{{json .}}"], scope.root);
    if (result.exitCode !== 0) snapshot.runtimeMessage = "Docker Engine is unavailable. Start Docker and refresh.";
    else snapshot.containers = parseDockerContainers(result.stdout);
  } catch { snapshot.runtimeMessage = "Docker Engine could not be inspected. Check Docker and refresh."; }
  return snapshot;
}

export async function dockerCommand(scope: ProjectToolScope, input: { action: DockerAction; file: string }): Promise<ToolCommandPreview> {
  if (!["up", "stop", "restart", "logs", "build"].includes(input.action)) throw toolError("invalid-input", "Unknown Docker action.");
  const discovered = await discoverToolFiles(scope.root, (name) => input.action === "build" ? isDockerfile(name) : isComposeFile(name));
  if (!discovered.files.includes(input.file)) throw toolError("not-found", "Docker configuration not found in this repository.");
  const file = await checkedToolPath(scope.root, input.file);
  const directory = dirname(file);
  if (input.action === "build") {
    const tag = `polyth-${scope.projectId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 80)}:local`;
    return projectToolCommand(scope, "Build image", `Build ${input.file} as ${tag}. Docker may download base images and run build steps.`, "docker", ["build", "--tag", tag, "-f", file, directory]);
  }
  const operations: Record<Exclude<DockerAction, "build">, { title: string; explanation: string; args: string[] }> = {
    up: { title: "Start services", explanation: "Create and start this Compose stack. Docker may build or pull images.", args: ["up", "--detach"] },
    stop: { title: "Stop services", explanation: "Stop this Compose stack while retaining its containers and volumes.", args: ["stop"] },
    restart: { title: "Restart services", explanation: "Restart this Compose stack. Its services will be briefly unavailable.", args: ["restart"] },
    logs: { title: "View logs", explanation: "Open the last 100 log lines and follow this Compose stack in the terminal.", args: ["logs", "--tail", "100", "--follow"] },
  };
  const operation = operations[input.action];
  if (!operation) throw toolError("invalid-input", "Unknown Docker action.");
  return projectToolCommand(scope, operation.title, operation.explanation, "docker", ["compose", "--project-directory", directory, "-f", file, ...operation.args]);
}
