import "./commands-settings.css";
import { defineWebPackage } from "@polyth/web-sdk";
import CommandsPage from "./CommandsPage.tsx";
import SkillsPage from "./SkillsPage.tsx";
export default defineWebPackage((host) => () => {
  const t = host.ui.locale.translate;
  const commands = host.settings.registerPage({
    id: "commands",
    packageId: "commands",
    label: t("settings.commandsindex.commandsLabel"),
    group: "Engineering",
    icon: "command",
    order: 30,
    component: CommandsPage,
    settingsItems: [
      { id: "commands.catalog", pageId: "commands", label: t("settings.commandspage.slashCommands"), description: t("settings.commandsindex.slashDescription"), keywords: ["slash", "action", "prompt", "custom", "built-in"], focusTarget: "commands.catalog" },
      { id: "commands.snippets", pageId: "commands", label: t("settings.commandspage.snippets"), description: t("settings.commandsindex.snippetsDescription"), keywords: ["snippet", "alias", "composer", "text"], focusTarget: "commands.snippets" },
    ],
  });
  const skills = host.settings.registerPage({
    id: "skills",
    packageId: "commands",
    label: t("settings.commandsindex.skillsLabel"),
    group: "Engineering",
    icon: "assist",
    order: 31,
    component: SkillsPage,
    settingsItems: [
      { id: "skills.catalog", pageId: "skills", label: t("settings.commandsindex.agentSkillsLabel"), description: t("settings.commandsindex.skillsDescription"), keywords: ["skill", "slash", "action", "instruction", "project", "space", "agent"], focusTarget: "skills.catalog" },
    ],
  });
  return () => { skills(); commands(); };
});
