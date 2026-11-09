// Offers smaller copies of the photos a composer was just given. Everything else
// in the same batch has already gone up; only heavy photos wait here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLocale, tr } from "../i18n/index.ts";
import type { TranslationKey } from "../i18n/index.ts";
import {
  encodeImageVariantsInTurn,
  formatImageBytes,
  IMAGE_UPLOAD_PRESET_IDS,
  imageSizeOptions,
  isResizableImage,
  recommendedImageSize,
  shouldAskImageSize,
  type ImageUploadSize,
  type ImageVariantEncoder,
  type ImageVariants,
} from "../imageUploadSize.ts";
import { getUiSettings, setUiSettings } from "../uiPrefs.ts";
import { Button, Checkbox, CloseIcon, IconButton } from "./ui/index.ts";
import "./ImageSizePrompt.css";

export interface ImageUploadRequest {
  file: File;
  /** Uploads the copy to keep (`file` itself when nothing was reduced) and
   *  reports its own failure. */
  commit(chosen: File): void | Promise<void>;
}

interface PendingImage extends Partial<ImageVariants> {
  request: ImageUploadRequest;
}

export interface ImageSizeChoice {
  pending: readonly PendingImage[];
  /** Hands over a batch; each file goes up at once or waits for the question. */
  offer(requests: readonly ImageUploadRequest[]): void;
  choose(size: ImageUploadSize, remember: boolean): void;
  cancel(): void;
}

export function useImageSizeChoice({ scopeKey, onScopeChanged, encode = encodeImageVariantsInTurn }: {
  /** The draft these photos belong to. Moving to another drops the question. */
  scopeKey: string;
  onScopeChanged: () => void;
  encode?: ImageVariantEncoder;
}): ImageSizeChoice {
  const [pending, setPending] = useState<readonly PendingImage[]>([]);
  const pendingRef = useRef(pending);
  const update = useCallback((next: (current: readonly PendingImage[]) => readonly PendingImage[]) => {
    pendingRef.current = next(pendingRef.current);
    setPending(pendingRef.current);
  }, []);
  const encodeRef = useRef(encode);
  encodeRef.current = encode;
  const onScopeChangedRef = useRef(onScopeChanged);
  onScopeChangedRef.current = onScopeChanged;

  const offer = useCallback((requests: readonly ImageUploadRequest[]) => {
    const preference = getUiSettings().imageUploadSize;
    const asked: PendingImage[] = [];
    for (const request of requests) {
      const { file } = request;
      if (preference === "ask" && shouldAskImageSize(file)) {
        asked.push({ request });
      } else if (preference === "ask" || preference === "original" || !isResizableImage(file)) {
        void request.commit(file);
      } else {
        void encodeRef.current(file, [preference]).then(({ variants }) => request.commit(variants[preference] ?? file));
      }
    }
    if (asked.length > 0) update((current) => [...current, ...asked]);
  }, [update]);

  // Real sizes, photo by photo, so the choice can be made on what it saves. One
  // that no preset can reduce, or the browser cannot decode, stops waiting.
  const measuring = useRef(new WeakSet<ImageUploadRequest>());
  useEffect(() => {
    const item = pending.find((candidate) => !candidate.variants && !measuring.current.has(candidate.request));
    if (!item) return;
    measuring.current.add(item.request);
    const { file } = item.request;
    void encodeRef.current(file, IMAGE_UPLOAD_PRESET_IDS).then(({ longEdge, variants }) => {
      if (!pendingRef.current.includes(item)) return;
      if (IMAGE_UPLOAD_PRESET_IDS.every((preset) => (variants[preset] ?? file) === file)) {
        update((current) => current.filter((candidate) => candidate !== item));
        void item.request.commit(file);
        return;
      }
      update((current) => current.map((candidate) => candidate === item ? { ...item, longEdge, variants } : candidate));
    });
  }, [pending, update]);

  const choose = useCallback((size: ImageUploadSize, remember: boolean) => {
    const items = pendingRef.current;
    update(() => []);
    if (remember) setUiSettings({ imageUploadSize: size });
    void (async () => {
      for (const { request, variants } of items) {
        const { file } = request;
        const chosen = size === "original"
          ? file
          : variants?.[size] ?? (await encodeRef.current(file, [size])).variants[size] ?? file;
        await request.commit(chosen);
      }
    })();
  }, [update]);

  const cancel = useCallback(() => update(() => []), [update]);

  const scopeRef = useRef(scopeKey);
  useEffect(() => {
    if (scopeRef.current === scopeKey) return;
    scopeRef.current = scopeKey;
    if (pendingRef.current.length === 0) return;
    update(() => []);
    onScopeChangedRef.current();
  }, [scopeKey, update]);

  return { pending, offer, choose, cancel };
}

const SIZE_LABELS: Record<ImageUploadSize, TranslationKey> = {
  small: "composer.imageSize.small",
  medium: "composer.imageSize.medium",
  large: "composer.imageSize.large",
  original: "composer.imageSize.original",
};

function PendingImageThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url ? <img className="image-size-prompt-thumb" src={url} alt="" /> : <span className="image-size-prompt-thumb" />;
}

function ImageSizeQuestion({ choice }: { choice: ImageSizeChoice }) {
  const [remember, setRemember] = useState(false);
  const { pending } = choice;
  const options = useMemo(() => imageSizeOptions(pending.map((item) => ({ ...item, file: item.request.file }))), [pending]);
  const recommended = recommendedImageSize(options);
  const locale = getLocale();
  const totalBytes = pending.reduce((total, item) => total + item.request.file.size, 0);
  const first = pending[0]!.request.file;
  return (
    <div className="image-size-prompt" role="group" aria-label={tr("composer.imageSize.title")}>
      <div className="image-size-prompt-head">
        <PendingImageThumb file={first} />
        <div className="image-size-prompt-copy">
          <strong role="status">{tr("composer.imageSize.title")}</strong>
          <span className="image-size-prompt-summary">
            {pending.length > 1
              ? tr("composer.imageSize.summaryMany", { count: pending.length, size: formatImageBytes(totalBytes, locale) })
              : first.name}
          </span>
        </div>
        <IconButton icon={CloseIcon} size="sm" label={tr("common.cancel")} onClick={choice.cancel} />
      </div>
      <div className="image-size-prompt-options">
        {options.map((option) => (
          <Button
            key={option.id}
            className="image-size-prompt-option"
            variant={option.id === recommended ? "primary" : "quiet"}
            onClick={() => choice.choose(option.id, remember)}
          >
            <span className="image-size-prompt-option-name">{tr(SIZE_LABELS[option.id])}</span>
            <span className="image-size-prompt-option-detail">
              {option.edge !== null && <span>{`${option.edge} px`}</span>}
              <span>
                {option.bytes === null
                  ? "…"
                  : `${option.approximate ? "≈ " : ""}${formatImageBytes(option.bytes, locale)}`}
              </span>
            </span>
          </Button>
        ))}
      </div>
      <Checkbox
        className="image-size-prompt-remember"
        checked={remember}
        onChange={setRemember}
        label={tr("composer.imageSize.remember")}
      />
    </div>
  );
}

export default function ImageSizePrompt({ choice }: { choice: ImageSizeChoice }) {
  return choice.pending.length > 0 ? <ImageSizeQuestion choice={choice} /> : null;
}
