// Browser-local workspace backgrounds. Presets are CSS-only; one custom image
// can be stored locally without bloating the server-synced settings blob.
export const BACKGROUND_PRESETS = [
  {
    id: "none",
    name: "None",
    description: "Theme color only",
    image: "none",
    preview: "linear-gradient(145deg, #17191d, #30343b)",
  },
  {
    id: "signal-bloom",
    name: "Signal Bloom",
    description: "Teal current · violet haze",
    image: "radial-gradient(circle at 14% 8%, rgba(55, 235, 195, .72) 0, rgba(55, 235, 195, 0) 34%), radial-gradient(circle at 86% 14%, rgba(116, 89, 255, .82) 0, rgba(116, 89, 255, 0) 39%), radial-gradient(circle at 68% 92%, rgba(242, 88, 142, .62) 0, rgba(242, 88, 142, 0) 41%), linear-gradient(145deg, #06191a 0%, #11152c 48%, #271329 100%)",
    preview: "radial-gradient(circle at 14% 8%, #37ebc3 0, transparent 38%), radial-gradient(circle at 86% 14%, #7459ff 0, transparent 42%), radial-gradient(circle at 68% 92%, #f2588e 0, transparent 44%), linear-gradient(#11152c, #11152c)",
  },
  {
    id: "blue-hour",
    name: "Blue Hour",
    description: "Cobalt dusk · cyan horizon",
    image: "radial-gradient(circle at 76% 18%, rgba(68, 218, 255, .7) 0, rgba(68, 218, 255, 0) 34%), radial-gradient(circle at 18% 74%, rgba(64, 91, 255, .74) 0, rgba(64, 91, 255, 0) 42%), linear-gradient(135deg, #05111f 0%, #0d2340 48%, #152d50 100%)",
    preview: "radial-gradient(circle at 76% 18%, #44daff 0, transparent 38%), radial-gradient(circle at 18% 74%, #405bff 0, transparent 46%), linear-gradient(#0d2340, #0d2340)",
  },
  {
    id: "ember-veil",
    name: "Ember Veil",
    description: "Copper light · plum shadow",
    image: "radial-gradient(circle at 18% 16%, rgba(255, 174, 91, .76) 0, rgba(255, 174, 91, 0) 36%), radial-gradient(circle at 83% 74%, rgba(190, 69, 135, .67) 0, rgba(190, 69, 135, 0) 43%), linear-gradient(140deg, #26120e 0%, #321826 48%, #171226 100%)",
    preview: "radial-gradient(circle at 18% 16%, #ffae5b 0, transparent 40%), radial-gradient(circle at 83% 74%, #be4587 0, transparent 46%), linear-gradient(#321826, #321826)",
  },
  {
    id: "moss-circuit",
    name: "Moss Circuit",
    description: "Fern glow · mineral gold",
    image: "radial-gradient(circle at 22% 14%, rgba(103, 229, 156, .67) 0, rgba(103, 229, 156, 0) 37%), radial-gradient(circle at 78% 82%, rgba(227, 175, 74, .58) 0, rgba(227, 175, 74, 0) 40%), linear-gradient(145deg, #071713 0%, #14251d 50%, #272014 100%)",
    preview: "radial-gradient(circle at 22% 14%, #67e59c 0, transparent 41%), radial-gradient(circle at 78% 82%, #e3af4a 0, transparent 44%), linear-gradient(#14251d, #14251d)",
  },
  {
    id: "paper-prism",
    name: "Paper Prism",
    description: "Ice blue · soft coral",
    image: "radial-gradient(circle at 12% 12%, rgba(95, 210, 226, .7) 0, rgba(95, 210, 226, 0) 37%), radial-gradient(circle at 86% 20%, rgba(159, 130, 239, .58) 0, rgba(159, 130, 239, 0) 38%), radial-gradient(circle at 62% 92%, rgba(242, 144, 131, .64) 0, rgba(242, 144, 131, 0) 42%), linear-gradient(145deg, #eaf7f5 0%, #eceafb 52%, #faeee9 100%)",
    preview: "radial-gradient(circle at 12% 12%, #5fd2e2 0, transparent 41%), radial-gradient(circle at 86% 20%, #9f82ef 0, transparent 42%), radial-gradient(circle at 62% 92%, #f29083 0, transparent 45%), linear-gradient(#eceafb, #eceafb)",
  },
] as const;

export type BackgroundPresetId = (typeof BACKGROUND_PRESETS)[number]["id"];
export type BackgroundId = BackgroundPresetId | "custom";

export interface BackgroundState {
  id: BackgroundId;
  customImage: string;
}

export const BACKGROUND_KEY = "polyth.background.v1";
export const DEFAULT_BACKGROUND_ID: BackgroundPresetId = "signal-bloom";
export const MAX_CUSTOM_BACKGROUND_BYTES = 2 * 1024 * 1024;
const MAX_DATA_URL_LENGTH = Math.ceil(MAX_CUSTOM_BACKGROUND_BYTES * 4 / 3) + 128;
const CUSTOM_IMAGE_RE = /^data:image\/(?:png|jpeg|webp|avif);base64,/i;
const PRESET_IDS = new Set<string>(BACKGROUND_PRESETS.map(({ id }) => id));
const subscribers = new Set<() => void>();

function isPresetId(value: unknown): value is BackgroundPresetId {
  return typeof value === "string" && PRESET_IDS.has(value);
}

function isCustomImage(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_DATA_URL_LENGTH && CUSTOM_IMAGE_RE.test(value);
}

export function parseBackgroundState(raw: string | null): BackgroundState {
  try {
    const value = JSON.parse(raw ?? "") as { id?: unknown; customImage?: unknown };
    const customImage = isCustomImage(value.customImage) ? value.customImage : "";
    const id = value.id === "custom" && customImage
      ? "custom"
      : isPresetId(value.id)
        ? value.id
        : DEFAULT_BACKGROUND_ID;
    return { id, customImage };
  } catch {
    return { id: DEFAULT_BACKGROUND_ID, customImage: "" };
  }
}

function loadBackgroundState(): BackgroundState {
  try {
    return typeof localStorage === "undefined"
      ? parseBackgroundState(null)
      : parseBackgroundState(localStorage.getItem(BACKGROUND_KEY));
  } catch {
    return parseBackgroundState(null);
  }
}

let state = loadBackgroundState();

export function backgroundCssImage(value: BackgroundState): string {
  if (value.id === "custom" && isCustomImage(value.customImage)) {
    return `url(${JSON.stringify(value.customImage)})`;
  }
  return BACKGROUND_PRESETS.find(({ id }) => id === value.id)?.image ?? "none";
}

export function applyBackgroundToDom(value = state): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.background = value.id;
  document.documentElement.style.setProperty("--app-background-image", backgroundCssImage(value));
}

function commit(next: BackgroundState): boolean {
  state = next;
  let saved = true;
  try {
    localStorage.setItem(BACKGROUND_KEY, JSON.stringify(next));
  } catch {
    saved = false;
  }
  applyBackgroundToDom(next);
  for (const notify of [...subscribers]) notify();
  return saved;
}

export function getBackground(): BackgroundState {
  return state;
}

export function subscribeBackground(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

export function setBackground(id: BackgroundId): boolean {
  if (id === "custom" && !state.customImage) return false;
  return commit({ ...state, id });
}

export function setCustomBackground(customImage: string): boolean {
  if (!isCustomImage(customImage)) return false;
  return commit({ id: "custom", customImage });
}

export function validateBackgroundFile(file: Pick<File, "size" | "type">): string | null {
  if (!/^image\/(?:png|jpeg|webp|avif)$/i.test(file.type)) {
    return "Choose a PNG, JPEG, WebP, or AVIF image.";
  }
  if (file.size > MAX_CUSTOM_BACKGROUND_BYTES) return "Choose an image under 2 MB.";
  return null;
}

// ponytail: localStorage keeps one custom image offline and dependency-free;
// move it to IndexedDB only if the 2 MB ceiling becomes restrictive.
export function readBackgroundFile(file: File): Promise<string> {
  const invalid = validateBackgroundFile(file);
  if (invalid) return Promise.reject(new Error(invalid));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that image."));
    reader.onload = () => {
      if (isCustomImage(reader.result)) resolve(reader.result);
      else reject(new Error("Could not use that image."));
    };
    reader.readAsDataURL(file);
  });
}
