import { useCallback, useEffect, useMemo, useState } from "react";
import type { PackageDescriptorDto } from "@polyth/contracts";
import { api } from "../../api.ts";
import { bootPackages, isPackageEnabled, subscribePackages } from "../../packages/registry.ts";
import { EmptyState, PageHead } from "./parts.tsx";

export default function PackagesPage() {
  const [packages, setPackages] = useState<PackageDescriptorDto[] | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

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

  const grouped = useMemo(() => ({
    core: packages?.filter((item) => item.core) ?? [],
    optional: packages?.filter((item) => !item.core) ?? [],
  }), [packages]);

  const setEnabled = async (descriptor: PackageDescriptorDto, enabled: boolean) => {
    setBusy(descriptor.id);
    setError("");
    try {
      const updated = await api.packagesSetEnabled(descriptor.id, enabled);
      setPackages((current) => current?.map((item) => item.id === updated.id ? updated : item) ?? null);
      await bootPackages();
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
        <PageHead title="Packages" blurb="Enable or disable optional workspace features." />
        <p className="muted">Loading installed Polyth packages…</p>
      </>
    );
  }

  return (
    <>
      <PageHead title="Packages" blurb="Enable or disable optional workspace features." />
      {error && <div className="form-error" role="alert">{error}</div>}
      {!packages && <EmptyState title="Packages unavailable" body="The package registry could not be loaded." />}
      {packages && (
        <div className="packages-list">
          <section className="package-group" aria-labelledby="optional-packages-title">
            <div className="package-group-head">
              <strong id="optional-packages-title">Optional packages</strong>
              <span>{grouped.optional.filter((item) => item.enabled).length} enabled</span>
            </div>
            <div className="package-grid">
              {grouped.optional.map((descriptor) => (
                <article className={`package-tile ${descriptor.enabled ? "enabled" : "disabled"}`} key={descriptor.id}>
                  <span className="package-icon" aria-hidden="true">{descriptor.icon ?? "◇"}</span>
                  <div className="package-copy">
                    <strong>{descriptor.name}</strong>
                    <p>{descriptor.description}</p>
                  </div>
                  <div className="package-tile-control">
                    <span>{descriptor.enabled ? "Enabled" : "Disabled"}</span>
                    <button
                      type="button"
                      className={`package-toggle ${descriptor.enabled ? "on" : ""}`}
                      role="switch"
                      aria-checked={descriptor.enabled}
                      aria-label={`${descriptor.enabled ? "Disable" : "Enable"} ${descriptor.name}`}
                      disabled={busy === descriptor.id}
                      onClick={() => { void setEnabled(descriptor, !descriptor.enabled); }}
                    >
                      <span />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
          <section className="package-group" aria-labelledby="core-packages-title">
            <div className="package-group-head">
              <strong id="core-packages-title">Core packages</strong>
              <span>Always enabled</span>
            </div>
            <div className="package-grid">
              {grouped.core.map((descriptor) => (
                <article className="package-tile package-tile-core enabled" key={descriptor.id}>
                  <span className="package-icon" aria-hidden="true">{descriptor.icon ?? "◆"}</span>
                  <div className="package-copy">
                    <strong>{descriptor.name}</strong>
                    <p>{descriptor.description}</p>
                  </div>
                  <div className="package-tile-control">
                    <span className="tag package-core-badge">Core</span>
                  </div>
                </article>
              ))}
            </div>
          </section>
          {isPackageEnabled("plugins") && (
            <button
              type="button"
              className="ghost-link packages-plugin-link"
              onClick={() => window.dispatchEvent(new CustomEvent("polyth:settings-page", { detail: "plugins" }))}
            >
              Manage third-party plugins →
            </button>
          )}
        </div>
      )}
    </>
  );
}
