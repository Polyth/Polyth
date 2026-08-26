// Tours for surfaces with no web installer of their own (built-in settings
// pages and server-side packages such as terminal or preview). Packages with
// a web installer register their tour from installXxxPackage instead, so
// disabling the package removes the tour with it.
import { registerPackageOnboarding } from "./registry.ts";
import { BUILTIN_TOURS } from "./tours/builtin.ts";
import { GIT_TOUR } from "./tours/git.ts";
import {
  AGENTS_TOUR,
  COMMANDS_TOUR,
  GITHUB_TOUR,
  HOME_ASSISTANT_TOUR,
  INTEGRATIONS_TOUR,
  KNOWLEDGE_TOUR,
  MCP_TOUR,
  MODELS_TOUR,
  PLUGINS_TOUR,
  SECURE_SAFE_TOUR,
  SSH_TOUR,
  USAGE_TOUR,
} from "./tours/installed.ts";
import { PACKAGES_TOUR } from "./tours/packages.ts";
import { VOICE_TOUR } from "./tours/voice.ts";

let registered = false;

export function registerBuiltinPackageTours(): void {
  if (registered) return;
  registered = true;
  registerPackageOnboarding(PACKAGES_TOUR);
  for (const tour of BUILTIN_TOURS) registerPackageOnboarding(tour);
  for (const tour of [
    GIT_TOUR,
    MODELS_TOUR,
    AGENTS_TOUR,
    USAGE_TOUR,
    GITHUB_TOUR,
    KNOWLEDGE_TOUR,
    HOME_ASSISTANT_TOUR,
    SECURE_SAFE_TOUR,
    MCP_TOUR,
    COMMANDS_TOUR,
    PLUGINS_TOUR,
    SSH_TOUR,
    INTEGRATIONS_TOUR,
    VOICE_TOUR,
  ]) registerPackageOnboarding(tour);
}
