import {
  useEffect, useRef, useState, useSyncExternalStore, type CSSProperties,
} from "react";
import {
  BACKGROUND_PRESETS,
  backgroundCssImage,
  backgroundPresetArt,
  documentAppearance,
  getBackground,
  readBackgroundFile,
  setBackground,
  setCustomBackground,
  subscribeAppearance,
  subscribeBackground,
  type BackgroundId,
} from "../backgrounds.ts";
import { useShiftArmed } from "../useShiftArmed.ts";
import { useStore } from "../store.ts";
import { Button, CheckIcon, IconButton, ImageIcon, Popover } from "./ui/index.ts";
import { tr } from "../i18n/index.ts";

function useBackground() {
  return useSyncExternalStore(subscribeBackground, getBackground, getBackground);
}

export function BackgroundPicker({ compact = false, onPick }: { compact?: boolean; onPick?: () => void }) {
  const background = useBackground();
  // Theme-following presets show the art the current theme paints.
  const appearance = useSyncExternalStore(subscribeAppearance, documentAppearance, documentAppearance);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choices: Array<{ id: BackgroundId; name: string; description: string; preview: string }> = [
    ...BACKGROUND_PRESETS.map((preset) => {
      const art = backgroundPresetArt(preset.id, appearance) ?? preset;
      // Preset names are titles of the artwork; only "None" is a word.
      return {
        id: preset.id,
        name: preset.id === "none" ? tr("backgrounds.noneName") : preset.name,
        description: tr(art.description),
        preview: art.preview ?? art.image,
      };
    }),
    ...(background.customImage
      ? [{
          id: "custom" as const,
          name: tr("backgrounds.yourImage"),
          description: tr("backgrounds.storedInBrowser"),
          preview: backgroundCssImage({ id: "custom", customImage: background.customImage }),
        }]
      : []),
  ];

  const pick = (id: BackgroundId) => {
    setError("");
    setBackground(id);
    onPick?.();
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const image = await readBackgroundFile(file);
      const saved = setCustomBackground(image);
      if (!saved) {
        setError(tr("backgrounds.notSaved"));
        return;
      }
      onPick?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className={`background-picker${compact ? " background-picker--compact" : ""}`}>
      <div className="background-grid" role="group" aria-label={tr("backgrounds.workspaceBackgrounds")}>
        {choices.map((choice) => (
          <button
            type="button"
            key={choice.id}
            className="background-option"
            data-background-id={choice.id}
            aria-label={tr("backgrounds.useBackground", { name: choice.name })}
            aria-pressed={background.id === choice.id}
            onClick={() => pick(choice.id)}
          >
            {/* The art is a thumbnail of its own; the name sits under it in
                the panel's inks, so it reads over any wallpaper. */}
            <span
              className="background-option-art"
              aria-hidden="true"
              style={{ backgroundImage: choice.preview, backgroundColor: "var(--bg)" } as CSSProperties}
            >
              {background.id === choice.id && <span className="background-option-check"><CheckIcon /></span>}
            </span>
            <span className="background-option-copy">
              <strong>{choice.name}</strong>
              <small>{choice.description}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="background-upload">
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/avif"
          onChange={(event) => void upload(event.target.files?.[0])}
        />
        <Button size="sm" busy={busy} onClick={() => inputRef.current?.click()}>
          {background.customImage ? tr("backgrounds.replaceImage") : tr("backgrounds.addImage")}
        </Button>
        <span>{tr("backgrounds.uploadHint")}</span>
      </div>
      {error && <div className="form-error background-error" role="alert">{error}</div>}
    </div>
  );
}

export default function BackgroundQuickPicker() {
  const shiftArmed = useShiftArmed();
  const overlay = useStore((snapshot) => snapshot.overlay);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (overlay !== null) setOpen(false);
  }, [overlay]);

  if (overlay !== null || (!shiftArmed && !open)) return null;

  return (
    <>
      <span ref={anchorRef} className="background-quick-trigger">
        <IconButton
          icon={ImageIcon}
          label={tr("backgrounds.change")}
          variant="quiet"
          size="lg"
          pressed={open}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        />
      </span>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        align="end"
        side="up"
        ariaLabel={tr("backgrounds.choose")}
        className="background-quick-popover"
        initialFocus=".background-option[aria-pressed='true']"
      >
        <div className="background-quick-head">
          <strong>{tr("settings.pages.workspaceBackground")}</strong>
          <span>{tr("backgrounds.quickHint")}</span>
        </div>
        <BackgroundPicker compact onPick={() => setOpen(false)} />
      </Popover>
    </>
  );
}
