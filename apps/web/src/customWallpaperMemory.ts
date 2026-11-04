// A custom wallpaper is a device asset kept in origin storage, and the native
// app's origin starts empty on every launch. So the app keeps a reduced copy in
// its own store and puts it back before the first render. That store allows
// 256 KB per record and 4 MB in all, shared with drafts and navigator state,
// while an upload can reach about 1.9 MB as a data URL. The running document
// keeps the image it was given; only the next launch gets the copy. A browser's
// origin storage holds that image, so there this does nothing.
import { hasClientPersistenceBackend, hydrateClientRecord, writeClientPreference } from "./clientPersistence.ts";
import { getBackground, parseBackgroundState, restoreCustomBackground, subscribeBackground } from "./backgrounds.ts";
import { shrinkImage } from "./imageShrink.ts";
import { clientAccountPersistenceScope } from "./reliabilityContext.ts";

const KIND = "custom-wallpaper-v1";
/** The whole record, as stored. */
export const CUSTOM_WALLPAPER_MAX_BYTES = 200 * 1024;
/** The record's JSON around the image. */
const RECORD_OVERHEAD = 40;
/** The first edge keeps a phone's cover crop crisp. */
const STORE_LADDER = { edges: [1600, 1280, 1024, 800, 640], qualities: [0.72, 0.5] };

export interface CustomWallpaper {
  /** Whether it is the wallpaper, or only offered in the picker. */
  active: boolean;
  image: string;
}

const encodeRecord = (active: boolean, image: string): string => JSON.stringify({ v: 1, active, image });

/** A record that is missing, corrupt, oversized or of another version, or one
 *  whose image was cleared, decodes to null: the launch has no custom image. */
export function decodeCustomWallpaper(raw: string | null): CustomWallpaper | null {
  if (!raw || raw.length > CUSTOM_WALLPAPER_MAX_BYTES) return null;
  let value: { v?: unknown; active?: unknown; image?: unknown };
  try { value = JSON.parse(raw) as typeof value; } catch { return null; }
  if (value?.v !== 1 || typeof value.active !== "boolean") return null;
  const parsed = parseBackgroundState(JSON.stringify({ id: "custom", customImage: value.image }));
  return parsed.id === "custom" ? { active: value.active, image: parsed.customImage } : null;
}

/** A copy of `image` that fits the record, or null when it cannot be made. */
export const reduceWallpaper = (image: string): Promise<string | null> =>
  shrinkImage(image, CUSTOM_WALLPAPER_MAX_BYTES - RECORD_OVERHEAD, STORE_LADDER);

let stopFollowing: (() => void) | null = null;

/** Put the last launch's custom wallpaper back, then keep the record in step
 *  with this document's choice. Never rejects: a failed read only means this
 *  launch has no custom image, and it leaves the record for the next one. An
 *  original already in origin storage (a reload within one app launch) wins
 *  over the reduced copy. */
export async function restoreCustomWallpaper(reduce: (image: string) => Promise<string | null> = reduceWallpaper): Promise<void> {
  if (stopFollowing !== null || !hasClientPersistenceBackend()) return;
  stopFollowing = () => undefined;
  const scope = clientAccountPersistenceScope();
  let stored: CustomWallpaper | null = null;
  try {
    stored = decodeCustomWallpaper(await hydrateClientRecord(KIND, scope));
  } catch { /* no head start */ }
  if (stored) restoreCustomBackground(stored.image, stored.active);

  // Presentation only: writeClientPreference never holds a send behind a full
  // store, unlike a removal. So a cleared image is a record with no image in it.
  const write = (active: boolean, image: string): void => writeClientPreference(KIND, scope, encodeRecord(active, image));
  let source = stored ? getBackground().customImage : "";
  let latest = 0;
  const sync = (): void => {
    const { id, customImage } = getBackground();
    const active = id === "custom";
    if (customImage === source) {
      if (stored && stored.active !== active) {
        stored = { ...stored, active };
        write(active, stored.image);
      }
      return;
    }
    source = customImage;
    latest += 1;
    const run = latest;
    // Out with the old image first: a reduction that fails, or never finishes
    // because the app was closed, must not bring it back on the next launch.
    stored = null;
    write(false, "");
    if (!customImage) return;
    void reduce(customImage).then((image) => {
      if (run !== latest || image === null) return;
      stored = { active: getBackground().id === "custom", image };
      write(stored.active, image);
    }).catch(() => undefined);
  };
  stopFollowing = subscribeBackground(sync);
  sync();
}

/** Test seam: forget this document's wallpaper memory state. */
export function resetCustomWallpaperForTest(): void {
  stopFollowing?.();
  stopFollowing = null;
}
