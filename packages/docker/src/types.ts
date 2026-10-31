import type { ProjectToolScope, ToolAvailability } from "@polyth/terminal/tool-types";

export interface DockerContainer {
  id: string;
  name: string;
  service: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}
export interface DockerSnapshot {
  scope: ProjectToolScope;
  cli: ToolAvailability;
  compose: ToolAvailability;
  composeFiles: string[];
  dockerfiles: string[];
  selectedCompose: string | null;
  services: string[];
  containers: DockerContainer[];
  runtimeMessage?: string;
  truncated: boolean;
}
export type DockerAction = "up" | "stop" | "restart" | "logs" | "build";
