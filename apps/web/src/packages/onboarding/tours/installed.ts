import type { PackageOnboardingTour } from "../types.ts";
import { tr } from "../../../i18n/index.ts";

export const MODELS_TOUR: PackageOnboardingTour = {
  packageId: "models",
  title: tr("packages.onboarding.tours.installed.providersModels"),
  steps: [
    // First: where models come from. A fresh install runs on OpenCode's free
    // models; installing other harnesses is an invitation, not a requirement.
    {
      id: "harnesses",
      title: tr("packages.onboarding.tours.installed.modelsComeFromHarnesses"),
      body: tr("packages.onboarding.tours.installed.polythTalksToModelsThroughHarnesses"),
      media: { kind: "pattern", pattern: "branches" },
      link: { settingsPage: "harnesses", label: tr("packages.onboarding.tours.installed.openHarnesses") },
    },
    {
      id: "overview",
      title: tr("packages.onboarding.tours.installed.controlTheModelCatalog"),
      body: tr("packages.onboarding.tours.installed.providersModelsShowsWhatTheBackendDiscovered"),
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "scope",
      title: tr("packages.onboarding.tours.installed.focusOnUsableProviders"),
      body: tr("packages.onboarding.tours.installed.switchBetweenConnectedProvidersAndTheFull"),
      highlight: tr("packages.onboarding.tours.installed.connected"),
      media: { kind: "pattern", pattern: "tiles" },
    },
    {
      id: "favorites",
      title: tr("packages.onboarding.tours.installed.keepPreferredModelsFirst"),
      body: tr("packages.onboarding.tours.installed.starTheModelsYouReachForMost"),
      highlight: tr("packages.onboarding.tours.installed.addFavorite"),
      media: { kind: "pattern", pattern: "rays" },
    },
  ],
};

// Catalog-only: production does not advertise a `roles` package, so this
// tour never becomes a live Roles settings entry by itself. (`agents` is the
// Agents package's own id.)
export const ROLES_TOUR: PackageOnboardingTour = {
  packageId: "roles",
  title: tr("packages.onboarding.tours.installed.roles"),
  steps: [
    {
      id: "overview",
      title: tr("packages.onboarding.tours.installed.shapeHowEachRoleWorks"),
      body: tr("packages.onboarding.tours.installed.rolesConfiguresAnAgentSInstructionsModel"),
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "roles",
      title: tr("packages.onboarding.tours.installed.tuneAReportedRole"),
      body: tr("packages.onboarding.tours.installed.editTheUsageModeProviderAndModel"),
      highlight: tr("packages.onboarding.tours.installed.editRole"),
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "profiles",
      title: tr("packages.onboarding.tours.installed.bundleRepeatableChoices"),
      body: tr("packages.onboarding.tours.installed.agentProfilesCombineAModelRoleAnd"),
      highlight: tr("packages.onboarding.tours.installed.agentProfiles"),
      media: { kind: "pattern", pattern: "tiles" },
    },
  ],
};




export const HOME_ASSISTANT_TOUR: PackageOnboardingTour = {
  packageId: "home-assistant",
  title: tr("packages.onboarding.tours.installed.homeAssistant"),
  steps: [
    {
      id: "overview",
      title: tr("packages.onboarding.tours.installed.yourHomeInTheWorkspace"),
      body: tr("packages.onboarding.tours.installed.connectOnceAndPolythBuildsYourHome"),
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "connection",
      title: tr("packages.onboarding.tours.installed.connectWithoutExposingTheToken"),
      body: tr("packages.onboarding.tours.installed.pasteTheAddressAndALongLivedToken"),
      highlight: tr("packages.onboarding.tours.installed.homeAssistantAddress"),
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "home",
      title: tr("packages.onboarding.tours.installed.openHomeFromTheSideRail"),
      body: tr("packages.onboarding.tours.installed.homeShowsYourRoomsAndFavourites"),
      highlight: tr("packages.onboarding.tours.installed.homeRailTab"),
      highlightWhere: "workspace",
      media: { kind: "pattern", pattern: "rays" },
    },
    {
      id: "agents",
      title: tr("packages.onboarding.tours.installed.letAgentsRunTheHouse"),
      body: tr("packages.onboarding.tours.installed.agentsSeeYourHomeByRoom"),
      highlight: tr("packages.onboarding.tours.installed.agentsTab"),
      media: { kind: "pattern", pattern: "tiles" },
    },
  ],
};

export const SECURE_SAFE_TOUR: PackageOnboardingTour = {
  packageId: "secure-safe",
  title: tr("packages.onboarding.tours.installed.secureSafe"),
  steps: [
    {
      id: "overview",
      title: tr("packages.onboarding.tours.installed.referenceCredentialsWithoutRevealingThem"),
      body: tr("packages.onboarding.tours.installed.secureSafeStoresValuesBehindReusableHandles"),
      media: { kind: "pattern", pattern: "rays" },
    },
    {
      id: "handles",
      title: tr("packages.onboarding.tours.installed.auditTheHandlesThatExist"),
      body: tr("packages.onboarding.tours.installed.reviewLabelsHandleNamesAndPurposesWithout"),
      highlight: tr("packages.onboarding.tours.installed.savedHandles"),
      media: { kind: "pattern", pattern: "tiles" },
    },
    {
      id: "add",
      title: tr("packages.onboarding.tours.installed.submitAValueOnce"),
      body: tr("packages.onboarding.tours.installed.createAClearHandleAndPurposeThen"),
      highlight: tr("packages.onboarding.tours.installed.addCredential"),
      media: { kind: "pattern", pattern: "orbit" },
    },
  ],
};

export const MCP_TOUR: PackageOnboardingTour = {
  packageId: "mcp",
  title: tr("packages.onboarding.tours.installed.mcp"),
  steps: [
    {
      id: "overview",
      title: tr("packages.onboarding.tours.installed.connectModelContextProtocolServers"),
      body: tr("packages.onboarding.tours.installed.mcpManagesStdioAndHttpToolServers"),
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "add",
      title: tr("packages.onboarding.tours.installed.configureAServerDirectly"),
      body: tr("packages.onboarding.tours.installed.addATransportCommandOrUrlAnd"),
      highlight: tr("packages.onboarding.tours.installed.mcpServer"),
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "import",
      title: tr("packages.onboarding.tours.installed.previewExistingConfiguration"),
      body: tr("packages.onboarding.tours.installed.pasteACompatibleMcpserversBlockInspectThe"),
      highlight: tr("packages.onboarding.tours.installed.importJson"),
      media: { kind: "pattern", pattern: "tiles" },
    },
  ],
};

export const COMMANDS_TOUR: PackageOnboardingTour = {
  packageId: "commands",
  title: tr("packages.onboarding.tours.installed.commandsSnippets"),
  steps: [
    {
      id: "overview",
      title: tr("packages.onboarding.tours.installed.savePromptsYouUseRepeatedly"),
      body: tr("packages.onboarding.tours.installed.commandsExpandsNamedPromptsFromTheComposer"),
      media: { kind: "pattern", pattern: "waveform" },
    },
    {
      id: "commands",
      title: tr("packages.onboarding.tours.installed.createSlashCommands"),
      body: tr("packages.onboarding.tours.installed.defineAProjectOrUserCommandAs"),
      highlight: tr("packages.onboarding.tours.installed.slashCommands"),
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "snippets",
      title: tr("packages.onboarding.tours.installed.insertSavedTextWithAnAlias"),
      body: tr("packages.onboarding.tours.installed.createAliasesForProjectSpecificOrGeneral"),
      highlight: tr("packages.onboarding.tours.installed.snippets"),
      media: { kind: "pattern", pattern: "tiles" },
    },
  ],
};

export const PLUGINS_TOUR: PackageOnboardingTour = {
  packageId: "plugins",
  title: tr("packages.onboarding.tours.installed.plugins"),
  steps: [
    {
      id: "overview",
      title: tr("packages.onboarding.tours.installed.extendTheWorkspaceDeliberately"),
      body: tr("packages.onboarding.tours.installed.pluginsCanContributeWidgetsCommandsToolsSettings"),
      media: { kind: "pattern", pattern: "tiles" },
    },
    {
      id: "library",
      title: tr("packages.onboarding.tours.installed.inspectWhatIsInstalled"),
      body: tr("packages.onboarding.tours.installed.reviewStatusContributionCountsPermissionsAndLogs"),
      highlight: tr("packages.onboarding.tours.installed.pluginLibrary"),
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "install",
      title: tr("packages.onboarding.tours.installed.addAnExplicitSource"),
      body: tr("packages.onboarding.tours.installed.installAVersionedNpmPackageOrA"),
      highlight: tr("packages.onboarding.tours.installed.install"),
      media: { kind: "pattern", pattern: "rays" },
    },
  ],
};


export const INTEGRATIONS_TOUR: PackageOnboardingTour = {
  packageId: "integrations",
  title: tr("packages.onboarding.tours.installed.integrations"),
  steps: [
    {
      id: "overview",
      title: tr("packages.onboarding.tours.installed.connectThroughLocalServiceTools"),
      body: tr("packages.onboarding.tours.installed.integrationsReportsExternalServiceReadinessThroughInstalled"),
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "github",
      title: tr("packages.onboarding.tours.installed.verifyGithubReadiness"),
      body: tr("packages.onboarding.tours.installed.checkThatTheGithubCliIsInstalled"),
      highlight: tr("packages.onboarding.tours.installed.githubCli"),
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "view",
      title: tr("packages.onboarding.tours.installed.continueIntoRepositoryWork"),
      body: tr("packages.onboarding.tours.installed.whenARepositoryIsDetectedOpenThe"),
      highlight: tr("packages.onboarding.tours.installed.openGithubView"),
      media: { kind: "pattern", pattern: "tiles" },
    },
  ],
};
