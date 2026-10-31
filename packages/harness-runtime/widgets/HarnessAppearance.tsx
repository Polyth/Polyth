import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { HarnessSnapshot } from "@polyth/contracts";
import { createApiTransport, isImeComposing, type WebPackageHost } from "@polyth/web-sdk";
import { invalidateRuntimeCatalogs } from "@polyth/models/runtime-catalog";
import { Notice, TextInput } from "../../../apps/web/src/components/ui/index.ts";
import { Row, Section } from "../../../apps/web/src/components/settings/parts.tsx";
import { HARNESS_COLORS } from "./presentation.ts";

const api = createApiTransport();
export const MAX_HARNESS_TITLE = 48;

type Appearance = { title: string; color: string };

/** A Space's own title and color for one harness. Both are presentation only:
 *  the harness id, routing and history never change. */
export default function HarnessAppearance({ host, detail, canManage }: { host: WebPackageHost; detail: HarnessSnapshot; canManage: boolean }) {
  const t = (key: string, values?: Record<string, string | number>) => host.ui.locale.translate(`harnessruntime.appearance.${key}`, values);
  const defaultName = detail.identity.defaultName ?? detail.identity.name;
  const saved: Appearance = { title: detail.identity.defaultName ? detail.identity.name : "", color: detail.identity.color ?? "" };
  const [title, setTitle] = useState(saved.title);
  const [color, setColor] = useState(saved.color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setTitle(saved.title); setColor(saved.color); }, [detail.identity.id, saved.title, saved.color]);

  const save = async (next: Appearance) => {
    const trimmed = next.title.trim();
    if (trimmed === saved.title && next.color === saved.color) return;
    setBusy(true);
    setError("");
    try {
      await api.put(`/api/harnesses/${encodeURIComponent(detail.identity.id)}/appearance`, { title: trimmed === defaultName ? "" : trimmed, color: next.color });
      // Every picker and label reads the harness name from these catalogs.
      invalidateRuntimeCatalogs();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setTitle(saved.title);
      setColor(saved.color);
    } finally {
      setBusy(false);
    }
  };
  const pick = (value: string) => { setColor(value); void save({ title, color: value }); };
  // The native color dialog reports every drag step; save once it settles.
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(settle.current), []);
  const drag = (value: string) => {
    setColor(value);
    clearTimeout(settle.current);
    settle.current = setTimeout(() => void save({ title, color: value }), 400);
  };
  const disabled = busy || !canManage;
  const custom = color !== "" && !HARNESS_COLORS.includes(color as typeof HARNESS_COLORS[number]);

  return <Section title={t("title")} hint={canManage ? t("hint") : host.ui.locale.translate("harnessruntime.settings.ownerOnly")}>
    <Row label={t("titleLabel")} hint={t("titleHint", { name: defaultName })}>
      <TextInput
        uiSize="sm"
        aria-label={t("titleAria", { name: defaultName })}
        placeholder={defaultName}
        maxLength={MAX_HARNESS_TITLE}
        value={title}
        disabled={disabled}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => void save({ title, color })}
        onKeyDown={(event) => {
          if (isImeComposing(event)) return;
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setTitle(saved.title);
        }}
      />
    </Row>
    <Row label={t("colorLabel")} hint={t("colorHint")}>
      <div className="pkg-harnesses-colors" role="group" aria-label={t("colorGroup", { name: defaultName })}>
        <button type="button" className="pkg-harnesses-color pkg-harnesses-color--none" aria-label={t("colorDefault")} aria-pressed={color === ""} disabled={disabled} onClick={() => pick("")} />
        {HARNESS_COLORS.map((preset) => <button
          key={preset}
          type="button"
          className="pkg-harnesses-color"
          style={{ "--pkg-harness-swatch": preset } as CSSProperties}
          aria-label={t("colorPreset", { color: preset })}
          aria-pressed={color === preset}
          disabled={disabled}
          onClick={() => pick(preset)}
        />)}
        <label className="pkg-harnesses-color pkg-harnesses-color--custom" data-selected={custom ? "true" : undefined} title={t("colorCustom")} data-disabled={disabled ? "true" : undefined}>
          <input type="color" aria-label={t("colorCustom")} value={color || "#3f7de8"} disabled={disabled} onChange={(event) => drag(event.target.value.toLowerCase())} />
        </label>
      </div>
    </Row>
    {error && <Notice tone="error" role="alert">{error}</Notice>}
  </Section>;
}
