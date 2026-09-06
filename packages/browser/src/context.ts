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
import { redactObservationText } from "./redact.ts";

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const asElement = (raw: Record<string, unknown>, secrets: ReadonlyArray<string>): BrowserContextElementSummary | null => {
  const selector = typeof raw.selector === "string" ? raw.selector : undefined;
  const tag = typeof raw.tag === "string" ? raw.tag : undefined;
  if (!selector && !tag) return null;
  const rect = raw.rect && typeof raw.rect === "object" && !Array.isArray(raw.rect)
    ? raw.rect as Record<string, unknown>
    : raw.bounds && typeof raw.bounds === "object" && !Array.isArray(raw.bounds)
      ? raw.bounds as Record<string, unknown>
      : null;
  const bounds = rect && Number.isFinite(Number(rect.x)) && Number.isFinite(Number(rect.y))
    ? {
      x: Math.round(Number(rect.x)),
      y: Math.round(Number(rect.y)),
      width: Math.round(Number(rect.width) || 0),
      height: Math.round(Number(rect.height) || 0),
    }
    : undefined;
  const attributes = raw.attributes && typeof raw.attributes === "object" && !Array.isArray(raw.attributes)
    ? Object.fromEntries(
      Object.entries(raw.attributes as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .slice(0, 12)
        .map(([k, v]) => [k, redactObservationText(v, { secrets, maxChars: 200 })]),
    )
    : undefined;
  const name = typeof raw.name === "string"
    ? redactObservationText(raw.name, { secrets, maxChars: 300 })
    : undefined;
  const text = typeof raw.text === "string"
    ? redactObservationText(raw.text, { secrets, maxChars: 500 })
    : undefined;
  return {
    ...(selector ? { selector } : {}),
    ...(tag ? { tag } : {}),
    ...(typeof raw.role === "string" ? { role: raw.role } : {}),
    ...(name ? { name } : {}),
    ...(text ? { text } : {}),
    ...(attributes && Object.keys(attributes).length ? { attributes } : {}),
    ...(bounds ? { bounds } : {}),
  };
};

export async function captureBrowserContext(args: {
  input: BrowserContextCaptureInput;
  session: BrowserSessionDto;
  page: DriverPage;
  artifacts: BrowserArtifactStore;
  secrets?: ReadonlyArray<string>;
}): Promise<BrowserContext> {
  const { input, session, page, artifacts } = args;
  const secrets = args.secrets ?? [];

  if (input.expectedRevision !== session.revision) {
    throw err(
      "stale-frame",
      `The page changed since this selection was made (frame ${input.expectedRevision} → ${session.revision}).`,
    );
  }
  if (!input.id || input.id.length > 100) {
    throw err("invalid-input", "browser context id required");
  }

  const nav = page.current();
  const base: BrowserContext = {
    id: input.id,
    type: input.type,
    browserSessionId: session.id,
    projectId: session.projectId,
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    frameRevision: session.revision,
    url: nav.url,
    title: nav.title,
    viewport: { width: session.viewport.width, height: session.viewport.height },
    capturedAt: new Date().toISOString(),
    ...(typeof input.note === "string" && input.note.trim()
      ? { note: input.note.trim().slice(0, 2_000) }
      : {}),
  };

  const wantFullShot = input.includeScreenshot ?? input.type === "page";
  const wantCrop = input.type === "element" || input.type === "area"
    ? input.includeScreenshot !== false
    : input.includeScreenshot === true;
  let fullShot: { data: Uint8Array; mime: string } | undefined;
  if (wantFullShot) {
    fullShot = await page.screenshot();
    base.screenshot = await artifacts.write(fullShot.data, fullShot.mime, `${input.id}-full`);
  }

  if (input.type === "page") {
    const observation = await page.observe();
    base.textSummary = redactObservationText(observation.text, { secrets, maxChars: 6_000 });
    base.accessibilitySummary = redactObservationText(observation.accessibilityDigest, {
      secrets,
      maxChars: 2_000,
    });
  }

  if (input.type === "element") {
    const pointed = asElement({ ...await page.point(input.point) }, secrets);
    if (!pointed) throw err("invalid-input", "no element at selection point");
    base.element = pointed;
    if (pointed.bounds && page.screenshotClip && wantCrop) {
      try {
        const crop = await page.screenshotClip({
          x: pointed.bounds.x,
          y: pointed.bounds.y,
          width: Math.max(1, pointed.bounds.width),
          height: Math.max(1, pointed.bounds.height),
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
        .map((el) => asElement({ ...el }, secrets))
        .filter((el): el is NonNullable<typeof el> => el !== null);
      base.textSummary = redactObservationText(region.text, { secrets, maxChars: 4_000 });
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
    quote = redactObservationText(quote, { secrets, maxChars: 4_000 }).trim();
    if (!quote) throw err("empty-text-range", "no usable text range");
    base.quote = quote;
    base.textSummary = quote;
  }

  base.contentHash = contentHashFor([
    base.id,
    base.type,
    base.url,
    base.title,
    String(base.frameRevision),
    base.quote,
    base.element?.selector,
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
