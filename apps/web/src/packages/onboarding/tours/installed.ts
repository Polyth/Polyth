import type { PackageOnboardingTour } from "../types.ts";
import { tr } from "../../../i18n/index.ts";

export const MODELS_TOUR: PackageOnboardingTour = {
  packageId: "models",
  title: tr("packages.onboarding.tours.installed.providersModels"),
  steps: [
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

// Catalog-only: production does not advertise an `agents` package, so this
// tour never becomes a live Roles settings entry by itself.
export const AGENTS_TOUR: PackageOnboardingTour = {
  packageId: "agents",
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

export const USAGE_TOUR: PackageOnboardingTour = {
  packageId: "usage",
  title: tr("packages.onboarding.tours.installed.usage"),
  steps: [
    {
      id: "overview",
      title: tr("packages.onboarding.tours.installed.understandModelActivityAndCost"),
      body: tr("packages.onboarding.tours.installed.usageCombinesSessionTokenAndCostTotals"),
      media: { kind: "pattern", pattern: "waveform" },
    },
    {
      id: "range",
      title: tr("packages.onboarding.tours.installed.compareThePeriodThatMatters"),
      body: tr("packages.onboarding.tours.installed.reviewSpendTokensAndRequestTrendsOver"),
      highlight: tr("packages.onboarding.tours.installed.usageOverview"),
      media: { kind: "pattern", pattern: "rays" },
    },
    {
      id: "providers",
      title: tr("packages.onboarding.tours.installed.watchProviderHealth"),
      body: tr("packages.onboarding.tours.installed.inspectQuotaWindowsPaceAccountFreshnessAnd"),
      highlight: tr("packages.onboarding.tours.installed.providers"),
      media: { kind: "pattern", pattern: "orbit" },
    },
  ],
};

export const GITHUB_TOUR: PackageOnboardingTour = {
  packageId: "github",
  title: tr("packages.onboarding.tours.installed.github"),
  steps: [
    {
      id: "overview",
      title: tr("packages.onboarding.tours.installed.keepRepositoryWorkInView"),
      body: tr("packages.onboarding.tours.installed.githubSurfacesProjectPullRequestsIssuesChecks"),
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "summary",
      title: tr("packages.onboarding.tours.installed.addTheActivePullRequestToYour"),
      body: tr("packages.onboarding.tours.installed.theSummaryWidgetLinksToTheCurrent"),
      highlight: tr("packages.onboarding.tours.installed.currentPullRequest"),
      highlightWhere: "workspace",
      media: { kind: "pattern", pattern: "tiles" },
    },
    {
      id: "metrics",
      title: tr("packages.onboarding.tours.installed.showOnlyUsefulDiffMetrics"),
      body: tr("packages.onboarding.tours.installed.chooseWhetherTheWidgetIncludesChangedFiles"),
      highlight: tr("packages.onboarding.tours.installed.changedFiles"),
      highlightWhere: "workspace",
      media: { kind: "pattern", pattern: "rays" },
    },
  ],
};

export const KNOWLEDGE_TOUR: PackageOnboardingTour = {
  packageId: "knowledge",
  title: tr("packages.onboarding.tours.installed.knowledge"),
  steps: [
    {
      id: "overview",
      title: tr("packages.onboarding.tours.installed.keepDurableProjectContext"),
      body: tr("packages.onboarding.tours.installed.knowledgeStoresNotesPlansAndReusableContext"),
      media: { kind: "pattern", pattern: "tiles" },
    },
    {
      id: "tracks",
      title: tr("packages.onboarding.tours.installed.executeASavedFeatureSpec"),
      body: tr("packages.onboarding.tours.installed.tracksTurnsASpecificationIntoTestedAtomic"),
      highlight: tr("packages.onboarding.tours.installed.tracks"),
      highlightWhere: "workspace",
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "notes",
      title: tr("packages.onboarding.tours.installed.keepReferenceMaterialVisible"),
      body: tr("packages.onboarding.tours.installed.addTheProjectKnowledgePanelToA"),
      highlight: tr("packages.onboarding.tours.installed.notesMemory"),
      highlightWhere: "workspace",
      media: { kind: "pattern", pattern: "orbit" },
    },
  ],
};

export const HOME_ASSISTANT_TOUR: PackageOnboardingTour = {
  packageId: "home-assistant",
  title: tr("packages.onboarding.tours.installed.homeAssistant"),
  steps: [
    {
      id: "overview",
      title: tr("packages.onboarding.tours.installed.bringSelectedHomeControlsIntoTheWorkspace"),
      body: tr("packages.onboarding.tours.installed.homeAssistantReadsConfiguredEntityStateAnd"),
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "connection",
      title: tr("packages.onboarding.tours.installed.connectWithoutExposingTheToken"),
      body: tr("packages.onboarding.tours.installed.setTheServerAddressAndTokenEnvironment"),
      highlight: tr("packages.onboarding.tours.installed.homeAssistantUrl"),
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "widgets",
      title: tr("packages.onboarding.tours.installed.chooseTheControlsYouNeed"),
      body: tr("packages.onboarding.tours.installed.placeAConnectionCardEntityStateLight"),
      highlight: tr("packages.onboarding.tours.installed.lightControl"),
      highlightWhere: "workspace",
      media: { kind: "pattern", pattern: "rays" },
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

export const SSH_TOUR: PackageOnboardingTour = {
  packageId: "ssh",
  title: tr("packages.onboarding.tours.installed.sshRemotes"),
  steps: [
    {
      id: "overview",
      title: tr("packages.onboarding.tours.installed.runCodingAgentsOnYourServers"),
      body: tr("packages.onboarding.tours.installed.sshRemotesKeepsAnInventoryOfServers"),
      media: { kind: "pattern", pattern: "branches" },
    },
    {
      id: "add",
      title: tr("packages.onboarding.tours.installed.registerAServerWithoutSecrets"),
      body: tr("packages.onboarding.tours.installed.addANameHostOrSshConfig"),
      highlight: tr("packages.onboarding.tours.installed.server"),
      media: { kind: "pattern", pattern: "tiles" },
    },
    {
      id: "test",
      title: tr("packages.onboarding.tours.installed.proveTheConnectionEndToEnd"),
      body: tr("packages.onboarding.tours.installed.testMeasuresTheRoundTripAndProbes"),
      highlight: tr("packages.onboarding.tours.installed.test"),
      media: { kind: "pattern", pattern: "orbit" },
    },
    {
      id: "remote-projects",
      title: tr("packages.onboarding.tours.installed.openProjectsOnTheServer"),
      body: tr("packages.onboarding.tours.installed.fromTheProjectPickerChooseOpenOn"),
      highlight: tr("packages.onboarding.tours.installed.openOnAServer"),
      highlightWhere: "workspace",
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
