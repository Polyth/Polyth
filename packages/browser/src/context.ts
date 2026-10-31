// Capture structured BrowserContext from a live revisioned browser session.
import type {
  BrowserContext,
  BrowserContextCaptureInput,
  BrowserContextElementSummary,
  BrowserSessionDto,
} from "@polyth/contracts";
import type { BrowserArtifactStore } from "./artifacts.ts";
import { contentHashFor } from "./artifacts.ts";
import type { DriverPage } from "./driver.ts";
import { redactObservationText, redactUrl } from "./redact.ts";

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const asElement = (
  raw: Record<string, unknown>,
  secrets: ReadonlyArray<string>,
  strictSecrets: ReadonlyArray<string>,
): BrowserContextElementSummary | null => {
  const selector = typeof raw.selector === "string"
    ? redactObservationText(raw.selector, { secrets, strictSecrets, maxChars: 1_000 }) : undefined;
  const tag = typeof raw.tag === "string" ? raw.tag : undefined;
  if (!selector && !tag) return null;
  const boundsOf = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const rect = value as Record<string, unknown>;
    if (![rect.x, rect.y, rect.width, rect.height].every((v) => typeof v === "number" && Number.isFinite(v))) return undefined;
    return { x: Math.round(rect.x as number), y: Math.round(rect.y as number),
      width: Math.round(rect.width as number), height: Math.round(rect.height as number) };
  };
  const bounds = boundsOf(raw.rect ?? raw.bounds);
  const documentBounds = boundsOf(raw.documentBounds);
  const attributes = raw.attributes && typeof raw.attributes === "object" && !Array.isArray(raw.attributes)
    ? Object.fromEntries(
      Object.entries(raw.attributes as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .slice(0, 12)
        .map(([k, v]) => [k, redactObservationText(k === "href" || k === "src" ? redactUrl(v) : v, { secrets, strictSecrets, maxChars: 200 })]),
    )
    : undefined;
  const name = typeof raw.name === "string"
    ? redactObservationText(raw.name, { secrets, strictSecrets, maxChars: 300 })
    : undefined;
  const text = typeof raw.text === "string"
    ? redactObservationText(raw.text, { secrets, strictSecrets, maxChars: 500 })
    : undefined;
  return {
    ...(selector ? { selector } : {}),
    ...(tag ? { tag } : {}),
    ...(typeof raw.role === "string" ? { role: raw.role } : {}),
    ...(name ? { name } : {}),
    ...(text ? { text } : {}),
    ...(attributes && Object.keys(attributes).length ? { attributes } : {}),
    ...(bounds ? { bounds } : {}),
    ...(documentBounds ? { documentBounds } : {}),
  };
};

export async function captureBrowserContext(args: {
  input: BrowserContextCaptureInput;
  session: BrowserSessionDto;
  page: DriverPage;
  artifacts: BrowserArtifactStore;
  secrets?: ReadonlyArray<string>;
  strictSecrets?: ReadonlyArray<string>;
}): Promise<BrowserContext> {
  const { input, session, page, artifacts } = args;
  const secrets = args.secrets ?? [];
  const strictSecrets = args.strictSecrets ?? [];

  if (input.expectedRevision !== session.revision) {
    throw err(
      "stale-frame",
      `The page changed since this selection was made (frame ${input.expectedRevision} → ${session.revision}).`,
    );
  }
  if (!input.id || input.id.length > 100) {
    throw err("invalid-input", "browser context id required");
  }

  const inViewport = (point: { x: number; y: number }) =>
    Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0
    && point.x < session.viewport.width && point.y < session.viewport.height;
  if (input.type === "element" && !inViewport(input.point)) throw err("invalid-input", "selection point is outside the viewport");
  if (input.type === "area" && (!Object.values(input.region).every(Number.isFinite)
    || input.region.x < 0 || input.region.y < 0 || input.region.width <= 0 || input.region.height <= 0
    || input.region.x + input.region.width > 1.000001 || input.region.y + input.region.height > 1.000001)) {
    throw err("invalid-input", "selection area is outside the viewport");
  }
  if (input.type === "text" && ((input.start && !inViewport(input.start)) || (input.end && !inViewport(input.end)))) {
    throw err("invalid-input", "text selection is outside the viewport");
  }

  const nav = page.current();
  const base: BrowserContext = {
    id: input.id,
    type: input.type,
    browserSessionId: session.id,
    projectId: session.projectId,
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    frameRevision: session.revision,
    url: redactObservationText(redactUrl(nav.url), { secrets, strictSecrets, maxChars: 2_000 }),
    title: redactObservationText(nav.title, { secrets, strictSecrets, maxChars: 500 }),
    viewport: { width: session.viewport.width, height: session.viewport.height },
    capturedAt: new Date().toISOString(),
    ...(typeof input.note === "string" && input.note.trim()
      ? { note: redactObservationText(input.note.trim(), { secrets, strictSecrets, maxChars: 2_000 }) }
      : {}),
  };

  const wantFullShot = input.includeScreenshot ?? input.type === "page";
  const wantCrop = input.type === "element" || input.type === "area"
    ? input.includeScreenshot !== false : input.includeScreenshot === true;
  let fullShot: { data: Uint8Array; mime: string } | undefined;
  if (wantFullShot) {
    fullShot = await page.screenshot();
    base.screenshot = await artifacts.write(fullShot.data, fullShot.mime, `${input.id}-full`);
  }

  if (input.type === "page") {
    const observation = await page.observe();
    base.textSummary = redactObservationText(observation.text, { secrets, strictSecrets, maxChars: 6_000 });
    base.accessibilitySummary = redactObservationText(observation.accessibilityDigest, {
      secrets,
      strictSecrets,
      maxChars: 2_000,
    });
  }

  if (input.type === "element") {
    const pointed = asElement({ ...await page.point(input.point) }, secrets, strictSecrets);
    base.point = { x: Math.round(input.point.x), y: Math.round(input.point.y) };
    if (pointed) base.element = pointed;
    const bounds = pointed?.bounds ?? { x: Math.max(0, input.point.x - 24), y: Math.max(0, input.point.y - 24), width: 48, height: 48 };
    if (page.screenshotClip && wantCrop) {
      try {
        const crop = await page.screenshotClip({
          x: Math.max(0, bounds.x),
          y: Math.max(0, bounds.y),
          width: Math.max(1, Math.min(bounds.x + bounds.width, session.viewport.width) - Math.max(0, bounds.x)),
          height: Math.max(1, Math.min(bounds.y + bounds.height, session.viewport.height) - Math.max(0, bounds.y)),
        });
        base.crop = await artifacts.write(crop.data, crop.mime, `${input.id}-crop`);
      } catch {
        // crop is best-effort
      }
    }
  }

  if (input.type === "area") {
    const n = input.region;
    if (!(n.width > 0 && n.height > 0)) throw err("invalid-input", "area region must have positive size");
    const pixels = {
      x: Math.round(n.x * session.viewport.width),
      y: Math.round(n.y * session.viewport.height),
      width: Math.max(1, Math.round(n.width * session.viewport.width)),
      height: Math.max(1, Math.round(n.height * session.viewport.height)),
    };
    base.region = {
      normalized: {
        x: Math.max(0, Math.min(1, n.x)),
        y: Math.max(0, Math.min(1, n.y)),
        width: Math.max(0, Math.min(1, n.width)),
        height: Math.max(0, Math.min(1, n.height)),
      },
      pixels,
    };
    if (page.queryRegion) {
      const region = await page.queryRegion(pixels);
      base.intersecting = region.elements
        .slice(0, 12)
        .map((el) => asElement({ ...el }, secrets, strictSecrets))
        .filter((el): el is NonNullable<typeof el> => el !== null);
      base.textSummary = redactObservationText(region.text, { secrets, strictSecrets, maxChars: 4_000 });
    }
    if (page.screenshotClip && wantCrop) {
      try {
        const crop = await page.screenshotClip(pixels);
        base.crop = await artifacts.write(crop.data, crop.mime, `${input.id}-crop`);
      } catch {
        // crop is best-effort
      }
    }
  }

  if (input.type === "text") {
    let quote = (input.quote ?? "").trim();
    if (!quote && input.start && input.end && page.textRange) {
      const ranged = await page.textRange(input.start, input.end);
      const element = asElement({ ...await page.point(input.start) }, secrets, strictSecrets);
      if (element) base.element = element;
      quote = ranged.quote.trim();
      if (ranged.rect) {
        base.region = {
          normalized: {
            x: ranged.rect.x / Math.max(1, session.viewport.width),
            y: ranged.rect.y / Math.max(1, session.viewport.height),
            width: ranged.rect.width / Math.max(1, session.viewport.width),
            height: ranged.rect.height / Math.max(1, session.viewport.height),
          },
          pixels: ranged.rect,
        };
      }
    }
    quote = redactObservationText(quote, { secrets, strictSecrets, maxChars: 4_000 }).trim();
    if (!quote) throw err("empty-text-range", "no usable text range");
    base.quote = quote;
    base.textSummary = quote;
    if (base.region && page.screenshotClip && wantCrop) {
      try {
        const crop = await page.screenshotClip(base.region.pixels);
        base.crop = await artifacts.write(crop.data, crop.mime, `${input.id}-crop`);
      } catch { /* text and location survive a failed crop */ }
    }
  }

  base.contentHash = contentHashFor([
    base.id,
    base.type,
    base.url,
    base.title,
    String(base.frameRevision),
    base.quote,
    base.element?.selector,
    base.point ? JSON.stringify(base.point) : undefined,
    base.region ? JSON.stringify(base.region.normalized) : undefined,
    base.textSummary,
  ]);

  // Strip localPath from the wire payload — verifyAttachments re-resolves it.
  const scrub = (art: BrowserContext["screenshot"]): BrowserContext["screenshot"] =>
    art ? { id: art.id, mime: art.mime, size: art.size } : undefined;
  return {
    ...base,
    screenshot: scrub(base.screenshot),
    crop: scrub(base.crop),
  };
}
