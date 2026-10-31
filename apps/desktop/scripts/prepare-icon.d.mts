// Types for the desktop icon builder (prepare-icon.mjs).
export declare const APP_ICON_FILL: number;
export declare const APP_ICON_SIZE: number;
export declare const WINDOWS_ICON_SIZE: number;

export interface MarkBox {
  left: number;
  top: number;
  width: number;
  height: number;
  size: number;
}

/** Bounding box of the opaque mark inside a square RGBA image. */
export declare function markBox(
  data: Uint8Array,
  info: { width: number; height: number },
): MarkBox | null;

/** Re-frame the brand master's mark onto a square app-icon canvas (PNG bytes). */
export declare function buildAppIcon(sourcePath: string, size?: number, fill?: number): Promise<Buffer>;

/** Write both desktop app icons into the electron-builder build resources. */
export declare function prepareAppIcons(options?: { source?: string; buildDir?: string }): Promise<void>;
