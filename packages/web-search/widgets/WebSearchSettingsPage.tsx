import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  createApiTransport,
  type WebPackageHost,
} from "@polyth/web-sdk";
import {
  parseWebSearchSettingsSnapshot,
  type WebSearchSettingsSnapshot,
} from "@polyth/web-search/client";
import {
  WEB_SEARCH_REGIONS,
  type WebSearchSafeSearch,
  type WebSearchSettings,
} from "@polyth/web-search/settings";
import { EmptyState, ErrorState, PageHead, Row, SaveBar, Section, Seg, Toggle } from "../../../apps/web/src/components/settings/parts.tsx";
import { Badge, Notice } from "../../../apps/web/src/components/ui/index.ts";
import { webSearchCopy, type WebSearchCopy } from "./copy.ts";

type WebSearchRegion = (typeof WEB_SEARCH_REGIONS)[number];

// Region codes are "<country>-<language>" ("uk" is the United Kingdom). Names
// come from the browser in the reader's language; the language is added only
// for countries offered in more than one ("Canada (French)").
function regionLabel(region: WebSearchRegion, locale: string, worldwide: string): string {
  if (region === "wt-wt") return worldwide;
  const [country = "", language = ""] = region.split("-");
  const display = (type: "region" | "language", code: string) => {
    try { return new Intl.DisplayNames([locale, "en"], { type }).of(code) ?? code; } catch { return code; }
  };
  const name = display("region", country === "uk" ? "GB" : country.toUpperCase());
  const shared = WEB_SEARCH_REGIONS.filter((value) => value.startsWith(`${country}-`)).length > 1;
  return shared ? `${name} (${display("language", language)})` : name;
}

const safeOptions = (copy: WebSearchCopy): Array<[WebSearchSafeSearch, string]> => [
  ["strict", copy.safeStrict],
  ["moderate", copy.safeModerate],
  ["off", copy.safeOff],
];

export default function WebSearchSettingsPage({ host }: { host: WebPackageHost }) {
  const locale = host.ui.locale.get();
  const copy = webSearchCopy(locale);
  const api = useMemo(() => createApiTransport(), []);
  const generation = useRef(0);
  const mounted = useRef(true);
  const [snapshot, setSnapshot] = useState<WebSearchSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<WebSearchSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = async (): Promise<WebSearchSettingsSnapshot | null> => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = parseWebSearchSettingsSnapshot(await api.get<unknown>("/api/web-search/settings"));
      if (!mounted.current || generation.current !== current) return null;
      setSnapshot(result);
      setDraft(result.settings);
      return result;
    } catch (cause) {
      if (mounted.current && generation.current === current) {
        setSnapshot(null);
        setDraft(null);
        setError(host.errors.friendly(copy.title, cause));
      }
      return null;
    } finally {
      if (mounted.current && generation.current === current) setLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  const update = <K extends keyof WebSearchSettings>(key: K, value: WebSearchSettings[K]) => {
    generation.current += 1;
    setStatus(null);
    setDraft((current) => current ? { ...current, [key]: value } : current);
  };

  const save = async () => {
    if (!draft || !snapshot || busy) return;
    if (draft.provider === "tavily" && !draft.tavilyCredentialHandle) {
      setError(copy.tavilyNeedsKey);
      return;
    }
    const requestGeneration = generation.current;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = parseWebSearchSettingsSnapshot(await api.put<unknown>("/api/web-search/settings", {
        settings: draft,
        expectedRevision: snapshot.revision,
      }));
      if (!mounted.current || generation.current !== requestGeneration) return;
      setSnapshot(result);
      setDraft(result.settings);
      setStatus(copy.saved);
    } catch (cause) {
      if (!mounted.current || generation.current !== requestGeneration) return;
      if (cause instanceof ApiError && cause.status === 409) {
        setError(copy.conflict);
        await load();
      } else {
        setError(host.errors.friendly(copy.title, cause));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const { Button, Select } = host.ui.components;
  const handleOptions = draft?.tavilyCredentialHandle && !snapshot?.credentialHandles.some((item) => item.handle === draft.tavilyCredentialHandle)
    ? [{ handle: draft.tavilyCredentialHandle, label: `${draft.tavilyCredentialHandle} · ${copy.unavailable}` }, ...(snapshot?.credentialHandles ?? [])]
    : snapshot?.credentialHandles ?? [];

  if (loading && !snapshot) {
    return <EmptyState busy title={copy.loading} />;
  }
  if (!snapshot || !draft) {
    return <ErrorState title={copy.loadFailed} error={error ?? copy.loadFailed} onRetry={() => void load()} />;
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(snapshot.settings);
  const missingTavilyKey = draft.provider === "tavily" && !draft.tavilyCredentialHandle;
  const providerHint = draft.provider === "duckduckgo"
    ? copy.providerDuckDuckGoHint
    : draft.provider === "tavily" ? copy.providerTavilyHint : copy.providerDescription;

  return (
    <div className="pkg-web-search-settings">
      <PageHead title={copy.title} blurb={copy.description} />

      <Section title={copy.searchSection}>
        <Row label={copy.enabled} hint={copy.enabledDescription} itemId="web-search.enabled">
          <Toggle on={draft.enabled} label={copy.enabled} disabled={busy} onChange={(checked) => update("enabled", checked)} />
        </Row>
        <Row label={copy.provider} hint={providerHint} itemId="web-search.provider" disabled={!draft.enabled}>
          <Seg
            value={draft.provider}
            label={copy.provider}
            disabled={busy}
            options={[["auto", copy.providerAuto], ["duckduckgo", "DuckDuckGo"], ["tavily", "Tavily"]]}
            onChange={(value) => update("provider", value)}
          />
        </Row>
        <Row label={copy.region} hint={copy.regionDescription} itemId="web-search.region" disabled={!draft.enabled}>
          <Select
            label={copy.region}
            ariaLabel={copy.region}
            value={draft.region}
            disabled={busy}
            options={WEB_SEARCH_REGIONS.map((region) => ({ value: region, label: regionLabel(region, locale, copy.regionWorldwide) }))}
            onChange={(value: unknown) => update("region", String(value) as WebSearchSettings["region"])}
          />
        </Row>
        <Row label={copy.safeSearch} hint={copy.safeSearchDescription} itemId="web-search.safe-search" disabled={!draft.enabled}>
          <Seg
            value={draft.safeSearch}
            label={copy.safeSearch}
            disabled={busy}
            options={safeOptions(copy)}
            onChange={(value) => update("safeSearch", value)}
          />
        </Row>
        <Row label={copy.resultLimit} hint={copy.resultLimitDescription} itemId="web-search.result-limit" disabled={!draft.enabled}>
          <Seg
            value={draft.maxResults}
            label={copy.resultLimit}
            disabled={busy}
            options={[5, 8, 10].map((value): [number, string] => [value, String(value)])}
            onChange={(value) => update("maxResults", value)}
          />
        </Row>
      </Section>

      <Section title={copy.credentialSection} hint={copy.credentialDescription}>
        <Row
          label={copy.credential}
          hint={!snapshot.vaultAvailable
            ? <span className="pkg-web-search-settings__warning">{copy.vaultUnavailable}</span>
            : missingTavilyKey
              ? <span className="pkg-web-search-settings__warning">{copy.tavilyNeedsKey}</span>
              : handleOptions.length === 0 ? copy.noHandlesHint : copy.credentialHint}
          itemId="web-search.credential"
        >
          <Select
            label={copy.credential}
            ariaLabel={copy.credential}
            value={draft.tavilyCredentialHandle ?? ""}
            disabled={busy || !snapshot.vaultAvailable}
            options={[{ value: "", label: copy.noCredential }, ...handleOptions.map((item) => ({ value: item.handle, label: item.label && item.label !== item.handle ? `${item.label} · ${item.handle}` : item.handle }))]}
            onChange={(value: unknown) => {
              const handle = String(value);
              update("tavilyCredentialHandle", handle || undefined);
            }}
          />
        </Row>
        <div className="pkg-web-search-settings__link-row">
          <Button size="sm" variant="ghost" onClick={() => host.navigation.openSettingsPage("secure-safe")}>{copy.openVault}</Button>
        </div>
      </Section>

      <Section title={copy.providersTitle} itemId="web-search.providers">
        {snapshot.providers.map((provider) => (
          <Row
            key={provider.id}
            label={provider.name}
            hint={!provider.requiresCredential ? copy.keyless : provider.configured ? copy.configured : copy.notConfigured}
          >
            <Badge tone={provider.available ? "success" : "neutral"} dot>
              {provider.available ? copy.available : copy.unavailable}
            </Badge>
          </Row>
        ))}
      </Section>

      <Notice tone="info" className="pkg-web-search-settings__privacy">
        <strong>{copy.privacyTitle}</strong> {copy.privacyDescription}
      </Notice>

      {error ? <Notice tone="error" role="alert">{error}</Notice> : null}
      <SaveBar
        dirty={dirty}
        saving={busy}
        status={status ? "saved" : "idle"}
        saveLabel={copy.save}
        onSave={() => void save()}
        onDiscard={() => { generation.current += 1; setStatus(null); setError(null); setDraft(snapshot.settings); }}
      />
    </div>
  );
}
