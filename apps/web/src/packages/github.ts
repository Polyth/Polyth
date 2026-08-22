import { installGithubPlugin } from "../widgets/githubPlugin.tsx";

export function installGithubPackage(): () => void {
  return installGithubPlugin();
}
