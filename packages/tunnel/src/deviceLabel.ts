/** Names phones sent before they named themselves: every one was the same. */
const PLACEHOLDER_LABELS = new Set(["this phone", "mobile device"]);

const PLATFORM_LABELS: Record<string, string> = {
  ios: "iPhone",
  android: "Android",
};

const key = (label: string): string => label.toLocaleLowerCase();

/** A device's own name, or its platform when it sent only a placeholder. */
export function deviceBaseLabel(label: string, platform?: string | null): string {
  const clean = label.trim();
  if (clean && !PLACEHOLDER_LABELS.has(key(clean))) return clean;
  return (platform && PLATFORM_LABELS[platform]) || clean;
}

/** `label` itself when no other name in `taken` matches it, otherwise the
 *  first free numbered form ("iPhone 2", "iPhone 3"…), at most 80 chars. */
export function uniqueDeviceLabel(label: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(key));
  if (!label || !used.has(key(label))) return label;
  for (let n = 2; ; n += 1) {
    const suffix = ` ${n}`;
    const candidate = label.slice(0, 80 - suffix.length).trimEnd() + suffix;
    if (!used.has(key(candidate))) return candidate;
  }
}

/** What one account's Link page calls each of its devices. Older pairings may
 *  share a name, so later ones (by pairing time) get a number. */
export function distinctDeviceLabels(
  devices: ReadonlyArray<{ id: string; label: string; platform: string | null; createdAt: number }>,
): Map<string, string> {
  const ordered = [...devices]
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((device) => ({ id: device.id, base: deviceBaseLabel(device.label, device.platform) }));
  // A number never lands on a name another device already carries.
  const taken = ordered.map((device) => device.base);
  const claimed = new Set<string>();
  const shown = new Map<string, string>();
  for (const device of ordered) {
    const label = claimed.has(key(device.base)) ? uniqueDeviceLabel(device.base, taken) : device.base;
    if (label !== device.base) taken.push(label);
    claimed.add(key(label));
    shown.set(device.id, label);
  }
  return shown;
}
