import { useCallback, useEffect, useMemo, useState } from "react";
import type { PackageDescriptorDto } from "@polyth/contracts";
import { api } from "@polyth/session/web-api";
import { bootPackages, isPackageEnabled, subscribePackages } from "../../packages/registry.ts";
import { maybeAutoShowPackageTour, openPackageTour } from "../../packages/onboarding/controller.ts";
import { canonicalTourPackageId } from "../../packages/onboarding/pageMap.ts";
import { getPackageOnboarding, subscribePackageOnboardings } from "../../packages/onboarding/registry.ts";
import { EmptyState, PageHead } from "./parts.tsx";
import { PackageGlyph } from "./packageIcons.tsx";
import { tr, type TranslationKey } from "../../i18n/index.ts";
import { Button, Switch, TextInput } from "../ui/index.ts";

const PACKAGE_NAME_KEYS: Readonly<Record<string, TranslationKey>> = {
  git: "packages.git.git",
  terminal: "capabilities.terminal",
  preview: "capabilities.preview",
  browser: "packages.onboarding.tours.builtin.browser",
  goals: "statusbar.goals",
  multirun: "packages.onboarding.tours.builtin.multirun",
  workflow: "statusbar.workflows",
  fusion: "statusbar.fusion",
  walkthrough: "statusbar.walkthrough",
  schedule: "statusbar.schedule",
  usage: "packages.usage.usage",
  knowledge: "capabilities.knowledge",
  dictation: "settings.packagespage.voiceAndDictation",
  "home-assistant": "packages.homeAssistant.homeAssistant",
  "secure-safe": "packages.secureSafe.secureSafe",
  ssh: "packages.ssh.sshRemotes",
  mcp: "packages.mcp.mcp",
  commands: "packages.commands.commands",
  plugins: "packages.plugins.plugins",
  integrations: "packages.integrations.integrations",
};

const PACKAGE_DESCRIPTION_KEYS: Readonly<Record<string, TranslationKey>> = {
  git: "settings.packagespage.gitDescription",
  terminal: "settings.packagespage.terminalDescription",
  preview: "settings.packagespage.previewDescription",
  browser: "settings.packagespage.browserDescription",
  goals: "settings.packagespage.goalsDescription",
  multirun: "settings.packagespage.multirunDescription",
  workflow: "settings.packagespage.workflowDescription",
  fusion: "settings.packagespage.fusionDescription",
  walkthrough: "settings.packagespage.walkthroughDescription",
  schedule: "settings.packagespage.scheduleDescription",
  usage: "settings.packagespage.usageDescription",
  github: "settings.packagespage.githubDescription",
  knowledge: "settings.packagespage.knowledgeDescription",
  dictation: "settings.packagespage.dictationDescription",
  "home-assistant": "settings.packagespage.homeAssistantDescription",
  "secure-safe": "settings.packagespage.secureSafeDescription",
  ssh: "settings.packagespage.sshDescription",
  mcp: "packages.mcp.modelContextProtocolServerConfiguration",
  commands: "settings.packagespage.commandsDescription",
  plugins: "settings.packagespage.pluginsDescription",
  integrations: "settings.packagespage.integrationsDescription",
};

const packageName = (descriptor: PackageDescriptorDto): string => {
  const key = PACKAGE_NAME_KEYS[descriptor.id];
  return key ? tr(key) : descriptor.name;
};

const packageDescription = (descriptor: PackageDescriptorDto): string => {
  const key = PACKAGE_DESCRIPTION_KEYS[descriptor.id];
  return key ? tr(key) : descriptor.description;
};

/** "Tour" replay button on a package tile — shown only when a tour is
 * registered for the (canonical) package, and it always opens as a preview,
 * even after the user skipped that tour or all onboardings. */
function PackageTourButton({ descriptor }: { descriptor: PackageDescriptorDto }) {
  const packageId = canonicalTourPackageId(descriptor.id);
  if (!getPackageOnboarding(packageId)) return null;
  const name = packageName(descriptor);
  return (
    <Button
      size="sm"
      variant="ghost"
      className="package-tour-btn"
      aria-label={tr("settings.packagespage.previewTheValueTour", { name })}
      onClick={() => openPackageTour(packageId, "preview")}
    >
      {tr("settings.packagespage.tour")}
    </Button>
  );
}

export default function PackagesPage() {
  const [packages, setPackages] = useState<PackageDescriptorDto[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await api.packagesList();
      setPackages(response.packages);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    return subscribePackages(() => { void load(); });
  }, [load]);

  // Re-render tiles when tours register/unregister (package enable/disable).
  const [, setToursAt] = useState(0);
  useEffect(() => subscribePackageOnboardings(() => setToursAt((value) => value + 1)), []);

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = packages?.filter((item) => `${item.id} ${packageName(item)} ${packageDescription(item)}`.toLowerCase().includes(needle)) ?? [];
    return { core: matching.filter((item) => item.core), optional: matching.filter((item) => !item.core) };
  }, [packages, query]);

  const setEnabled = async (descriptor: PackageDescriptorDto, enabled: boolean) => {
    setBusy(descriptor.id);
    setError("");
    try {
      const updated = await api.packagesSetEnabled(descriptor.id, enabled);
      setPackages((current) => current?.map((item) => item.id === updated.id ? updated : item) ?? null);
      await bootPackages();
      // A freshly enabled package introduces itself once (unless skipped).
      if (enabled) maybeAutoShowPackageTour(canonicalTourPackageId(descriptor.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await load();
    } finally {
      setBusy("");
    }
  };

  if (!packages && !error) {
    return (
      <>
        <PageHead title={tr("settings.packagespage.packages")} blurb={tr("settings.packagespage.enableOrDisableOptionalWorkspaceFeatures")} />
        <EmptyState title={tr("settings.packagespage.loadingInstalledPolythPackages")} busy />
      </>
    );
  }

  return (
    <>
      <PageHead title={tr("settings.packagespage.packages")} blurb={tr("settings.packagespage.enableOrDisableOptionalWorkspaceFeatures")} />
      {error && <div className="form-error" role="alert">{error}</div>}
      {!packages && <EmptyState title={tr("settings.packagespage.packagesUnavailable")} body={tr("settings.packagespage.thePackageRegistryCouldNotBeLoaded")} />}
      {packages && (
        <div className="packages-list">
          <TextInput type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={`${tr("common.search")} ${tr("settings.packagespage.packages")}`} placeholder={`${tr("common.search")} ${tr("settings.packagespage.packages")}…`} />
          {grouped.optional.length === 0 && grouped.core.length === 0 && <EmptyState title={tr("picker.noMatches")} />}
          {grouped.optional.length > 0 && <section className="package-group" aria-labelledby="optional-packages-title">
            <div className="package-group-head">
              <strong id="optional-packages-title">{tr("settings.packagespage.optionalPackages")}</strong>
              <span>{grouped.optional.filter((item) => item.enabled).length} {tr("settings.packagespage.enabled2")}</span>
            </div>
            <div className="package-grid">
              {grouped.optional.map((descriptor) => (
                <article className={`package-tile ${descriptor.enabled ? "enabled" : "disabled"}`} key={descriptor.id}>
                  <span className="package-icon" aria-hidden="true"><PackageGlyph icon={descriptor.icon} /></span>
                  <div className="package-copy">
                    <strong>{packageName(descriptor)}</strong>
                    <p>{packageDescription(descriptor)}</p>
                  </div>
                  <div className="package-tile-control">
                    <PackageTourButton descriptor={descriptor} />
                    <Switch
                      checked={descriptor.enabled}
                      label={descriptor.enabled
                        ? tr("settings.packagespage.disableValue", { value: packageName(descriptor) })
                        : tr("settings.packagespage.enableValue", { value: packageName(descriptor) })}
                      disabled={busy === descriptor.id}
                      onChange={(enabled) => { void setEnabled(descriptor, enabled); }}
                    />
                  </div>
                </article>
              ))}
            </div>
          </section>}
          {grouped.core.length > 0 && <section className="package-group" aria-labelledby="core-packages-title">
            <div className="package-group-head">
              <strong id="core-packages-title">{tr("settings.packagespage.corePackages")}</strong>
              <span>{tr("settings.packagespage.alwaysEnabled")}</span>
            </div>
            <div className="package-grid">
              {grouped.core.map((descriptor) => (
                <article className="package-tile package-tile-core enabled" key={descriptor.id}>
                  <span className="package-icon" aria-hidden="true"><PackageGlyph icon={descriptor.icon} /></span>
                  <div className="package-copy">
                    <strong>{packageName(descriptor)}</strong>
                    <p>{packageDescription(descriptor)}</p>
                  </div>
                  <div className="package-tile-control">
                    <PackageTourButton descriptor={descriptor} />
                    <span className="tag package-core-badge">{tr("settings.packagespage.core")}</span>
                  </div>
                </article>
              ))}
            </div>
          </section>}
          {isPackageEnabled("plugins") && (
            <Button
              variant="ghost"
              size="sm"
              className="packages-plugin-link"
              onClick={() => window.dispatchEvent(new CustomEvent("polyth:settings-page", { detail: "plugins" }))}
            >
              {tr("settings.packagespage.manageThirdPartyPlugins")}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
