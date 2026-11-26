// Custom accent picker: a saturation/brightness field, a hue slider, an
// eyedropper where the browser has one, RGB fields and a Select button.
//
// It replaces a native <input type="color">, whose chooser reports the final
// colour only as a `change` when the browser decides the choice has ended.
// Closing it with Escape or a click elsewhere often ended without one, so the
// picked colour previewed and was then lost. Here every edit previews and only
// Select saves; the button is painted in the accent the colour will become.
import { useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { tr } from "../../i18n/index.ts";
import { PipetteIcon } from "../ui/icons.ts";

export type Rgb = [number, number, number];
export interface Hsv { h: number; s: number; v: number }

const HEX = /^#?([0-9a-f]{6})$/i;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function hexToRgb(hex: string): Rgb | null {
  const match = HEX.exec(hex.trim());
  if (!match) return null;
  const n = parseInt(match[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}

/** A grey has no hue of its own, so it keeps the one the slider shows. */
export function rgbToHsv([r, g, b]: Rgb, fallbackHue = 0): Hsv {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const delta = max - Math.min(rn, gn, bn);
  let h = fallbackHue;
  if (delta > 0) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
    else h = 60 * ((rn - gn) / delta + 4);
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

interface EyeDropperLike { open(): Promise<{ sRGBHex: string }> }
type EyeDropperCtor = new () => EyeDropperLike;
const eyeDropper = (): EyeDropperCtor | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;

export interface AccentColorPickerProps {
  /** Colour the picker opens on (#rrggbb). */
  initial: string;
  /** Every edit, for a live preview. Nothing is saved. */
  onPreview: (hex: string) => void;
  /** The Select button: save this colour. */
  onSelect: (hex: string) => void;
  /** The accent and ink this colour is drawn with, for the Select button. */
  rolesFor: (hex: string) => { accent: string; accentInk: string };
}

const CHANNELS = [
  ["R", "settings.pages.accentRed"],
  ["G", "settings.pages.accentGreen"],
  ["B", "settings.pages.accentBlue"],
] as const;

export default function AccentColorPicker({ initial, onPreview, onSelect, rolesFor }: AccentColorPickerProps) {
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(hexToRgb(initial) ?? [0, 122, 255]));
  // A channel being typed shows the typed text until it is left, so clearing
  // a field to retype it does not snap back to a number.
  const [drafts, setDrafts] = useState<Partial<Record<0 | 1 | 2, string>>>({});
  const rgb = hsvToRgb(hsv);
  const hex = rgbToHex(rgb);
  const roles = rolesFor(hex);

  const update = (next: Hsv) => {
    setHsv(next);
    onPreview(rgbToHex(hsvToRgb(next)));
  };
  const fromField = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    update({
      h: hsv.h,
      s: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      v: clamp(1 - (event.clientY - rect.top) / rect.height, 0, 1),
    });
  };
  const fieldKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.01;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    update({ h: hsv.h, s: clamp(hsv.s + move[0], 0, 1), v: clamp(hsv.v + move[1], 0, 1) });
  };
  const editChannel = (index: 0 | 1 | 2, text: string) => {
    setDrafts((current) => ({ ...current, [index]: text }));
    if (!/^\d{1,3}$/.test(text)) return;
    const next: Rgb = [...rgb];
    next[index] = clamp(Number(text), 0, 255);
    update(rgbToHsv(next, hsv.h));
  };
  const leaveChannel = (index: 0 | 1 | 2) => setDrafts((current) => {
    const { [index]: _left, ...rest } = current;
    return rest;
  });
  const Dropper = eyeDropper();
  const sample = () => {
    if (!Dropper) return;
    new Dropper().open().then(({ sRGBHex }) => {
      const picked = hexToRgb(sRGBHex);
      if (picked) update(rgbToHsv(picked, hsv.h));
    }, () => { /* dismissed */ });
  };

  const style = {
    "--accent-picker-hue": `hsl(${hsv.h} 100% 50%)`,
    "--accent-picker-color": hex,
  } as CSSProperties;
  return (
    <div className="accent-picker" style={style}>
      <div
        className="accent-picker-field"
        role="slider"
        tabIndex={0}
        aria-label={tr("settings.pages.accentPickerField")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={`${Math.round(hsv.s * 100)}%, ${Math.round(hsv.v * 100)}%`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture?.(event.pointerId);
          fromField(event);
        }}
        onPointerMove={(event) => { if (event.buttons & 1) fromField(event); }}
        onKeyDown={fieldKey}
      >
        <span className="accent-picker-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <div className="accent-picker-row">
        {Dropper && (
          <button
            type="button"
            className="accent-picker-dropper"
            aria-label={tr("settings.pages.accentPickerEyedropper")}
            title={tr("settings.pages.accentPickerEyedropper")}
            onClick={sample}
          >
            <PipetteIcon aria-hidden="true" />
          </button>
        )}
        <span className="accent-picker-preview" aria-hidden="true" />
        <input
          type="range"
          className="accent-picker-hue"
          min={0}
          max={359}
          step={1}
          aria-label={tr("settings.pages.accentPickerHue")}
          value={Math.round(hsv.h) % 360}
          onChange={(event) => update({ ...hsv, h: Number(event.target.value) })}
        />
      </div>
      <div className="accent-picker-rgb">
        {CHANNELS.map(([letter, name], i) => {
          const index = i as 0 | 1 | 2;
          return (
            <label key={letter}>
              <input
                type="text"
                inputMode="numeric"
                maxLength={3}
                className="ui-input ui-input--sm"
                aria-label={tr(name)}
                value={drafts[index] ?? String(rgb[index])}
                onChange={(event) => editChannel(index, event.target.value)}
                onBlur={() => leaveChannel(index)}
                onKeyDown={(event) => { if (event.key === "Enter") onSelect(hex); }}
                autoComplete="off"
                spellCheck={false}
              />
              <span aria-hidden="true">{letter}</span>
            </label>
          );
        })}
      </div>
      <button
        type="button"
        className="accent-picker-select"
        style={{ background: roles.accent, color: roles.accentInk }}
        onClick={() => onSelect(hex)}
      >
        {tr("settings.pages.accentPickerSelect")}
      </button>
    </div>
  );
}
