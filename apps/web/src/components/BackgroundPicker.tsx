import {
  useEffect, useRef, useState, useSyncExternalStore, type CSSProperties,
} from "react";
import {
  BACKGROUND_PRESETS,
  backgroundCssImage,
  getBackground,
  readBackgroundFile,
  setBackground,
  setCustomBackground,
  subscribeBackground,
  type BackgroundId,
} from "../backgrounds.ts";
import { useShiftArmed } from "../useShiftArmed.ts";
import { useStore } from "../store.ts";
import { Button, CheckIcon, IconButton, ImageIcon, Popover } from "./ui/index.ts";

function useBackground() {
  return useSyncExternalStore(subscribeBackground, getBackground, getBackground);
}

export function BackgroundPicker({ compact = false, onPick }: { compact?: boolean; onPick?: () => void }) {
  const background = useBackground();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choices: Array<{ id: BackgroundId; name: string; description: string; preview: string }> = [
    ...BACKGROUND_PRESETS,
    ...(background.customImage
      ? [{
          id: "custom" as const,
          name: "Your image",
          description: "Stored in this browser",
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
        setError("Applied for this tab, but the browser could not save the image.");
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
      <div className="background-grid" role="group" aria-label="Workspace backgrounds">
        {choices.map((choice) => (
          <button
            type="button"
            key={choice.id}
            className="background-option"
            aria-label={`Use ${choice.name} background`}
            aria-pressed={background.id === choice.id}
            style={{
              backgroundImage: choice.preview,
              backgroundColor: "var(--bg)",
            } as CSSProperties}
            onClick={() => pick(choice.id)}
          >
            {background.id === choice.id && <span className="background-option-check"><CheckIcon aria-hidden="true" /></span>}
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
          {background.customImage ? "Replace your image" : "Add your image"}
        </Button>
        <span>PNG, JPEG, WebP or AVIF · up to 2 MB</span>
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
          label="Change workspace background"
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
        ariaLabel="Choose workspace background"
        className="background-quick-popover"
        initialFocus=".background-option[aria-pressed='true']"
      >
        <div className="background-quick-head">
          <strong>Workspace background</strong>
          <span>Glass looks best over a little atmosphere.</span>
        </div>
        <BackgroundPicker compact onPick={() => setOpen(false)} />
      </Popover>
    </>
  );
}
