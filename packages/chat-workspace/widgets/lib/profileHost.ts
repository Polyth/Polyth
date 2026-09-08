export function customProfileHost(customUrl?: string): string {
  if (!customUrl) return "";
  try {
    return new URL(customUrl).host;
  } catch {
    return customUrl;
  }
}
