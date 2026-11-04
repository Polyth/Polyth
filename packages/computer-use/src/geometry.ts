import { invalid } from "./errors.ts";
import type { Point, Rect, Size } from "./types.ts";

/** Screenshots are fitted into this box. Vision models resize larger images
 * themselves and then click in a space the tool cannot see; scaling here
 * keeps image pixels and click coordinates the same numbers. */
export const IMAGE_BOX: Size = { width: 1280, height: 800 };

export const fit = (source: Size, box: Size = IMAGE_BOX): Size => {
  const scale = Math.min(1, box.width / source.width, box.height / source.height);
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
};

/** Maps between screenshot (image) pixels and driver coordinates for one
 * screen size. It is a pure function of that size, so a click made after a
 * screenshot lands where the screenshot showed, as long as the display
 * itself did not change. */
export interface ScreenMapping {
  screen: Size;
  image: Size;
  toScreen(point: Point): Point;
  toImage(point: Point): Point;
  rectToScreen(rect: Rect): Rect;
  rectToImage(rect: Rect): Rect;
}

export const mappingFor = (screen: Size, box: Size = IMAGE_BOX): ScreenMapping => {
  const image = fit(screen, box);
  const sx = screen.width / image.width;
  const sy = screen.height / image.height;
  const toScreen = (point: Point): Point => {
    if (point.x < 0 || point.y < 0 || point.x >= image.width || point.y >= image.height) {
      throw invalid(`Point ${point.x},${point.y} is outside the screenshot (${image.width}×${image.height})`);
    }
    // The centre of the image pixel, clamped to the last screen pixel.
    return {
      x: Math.min(screen.width - 1, Math.floor((point.x + 0.5) * sx)),
      y: Math.min(screen.height - 1, Math.floor((point.y + 0.5) * sy)),
    };
  };
  // The image pixel that contains the screen point; the inverse of toScreen.
  const toImage = (point: Point): Point => ({
    x: Math.max(0, Math.min(image.width - 1, Math.floor(point.x / sx))),
    y: Math.max(0, Math.min(image.height - 1, Math.floor(point.y / sy))),
  });
  return {
    screen,
    image,
    toScreen,
    toImage,
    rectToScreen(rect) {
      if (rect.width < 1 || rect.height < 1) throw invalid("region needs a positive width and height");
      const left = Math.max(0, Math.floor(rect.x * sx));
      const top = Math.max(0, Math.floor(rect.y * sy));
      const right = Math.min(screen.width, Math.ceil((rect.x + rect.width) * sx));
      const bottom = Math.min(screen.height, Math.ceil((rect.y + rect.height) * sy));
      if (right - left < 1 || bottom - top < 1) throw invalid("region is outside the screenshot");
      return { x: left, y: top, width: right - left, height: bottom - top };
    },
    rectToImage(rect) {
      const x = Math.round(rect.x / sx);
      const y = Math.round(rect.y / sy);
      return {
        x, y,
        width: Math.round((rect.x + rect.width) / sx) - x,
        height: Math.round((rect.y + rect.height) / sy) - y,
      };
    },
  };
};
